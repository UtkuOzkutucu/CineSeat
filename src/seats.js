/**
 * Seat fetching and scanning.
 *
 * One showtime costs three upstream requests, one of which creates a transient
 * cart, so this is the only expensive thing the app does. Everything here is
 * about paying that cost as few times as possible:
 *
 *   - a short cache, so re-opening a showtime is free
 *   - minted tokens instead of the 56 KB ticket page (~36 ms vs ~343 ms)
 *   - ticket types remembered per session, and reused across a format group
 *   - scans run concurrently on the interactive lane
 */

import * as cv from './net/cineverse.js';
import { seats as seatCache, ticketTypes as typeStore } from './store.js';
import { findBestSeats, bestScore, describeSuggestion } from './algo/seatDetection.js';
import { search } from './config.js';

/**
 * The seat map for one showtime, with ranked suggestions.
 *
 * @param {object} args
 * @param {string} args.cinemaCode
 * @param {string} args.sessionId
 * @param {number} args.ticketCount
 * @param {string} [args.ticketTypeCode] defaults to the cheapest for this session
 * @param {object[]} [args.hintTicketTypes] types from a sibling showtime in the
 *   same format group — lets the first fetch of a session skip the big page
 * @param {boolean} [args.force] bypass the cache
 */
export async function getSeats({
  cinemaCode,
  sessionId,
  ticketCount,
  ticketTypeCode = null,
  hintTicketTypes = null,
  force = false,
}) {
  const known = typeStore.get(cinemaCode, sessionId);
  const resolvedType = ticketTypeCode ?? known?.[0]?.code ?? null;

  if (!force) {
    const hit = seatCache.get(cinemaCode, sessionId, ticketCount, resolvedType);
    if (hit) return withSuggestions(hit, ticketCount);
  }

  const result = await cv.fetchSeats({
    cinemaCode,
    sessionId,
    ticketCount,
    ticketTypeCode,
    // Prefer what we know about this exact session; fall back to a sibling's.
    knownTicketTypes: known ?? hintTicketTypes,
  });

  typeStore.set(cinemaCode, sessionId, result.ticketTypes);

  const payload = {
    ...result,
    bestScore: safeScore(result, ticketCount),
    scrapedAt: new Date().toISOString(),
    fromCache: false,
    ageSeconds: 0,
  };
  seatCache.set(cinemaCode, sessionId, ticketCount, result.ticketTypeCode, payload);

  return withSuggestions(payload, ticketCount);
}

function withSuggestions(seatMap, ticketCount) {
  let suggestions = [];
  try {
    suggestions = findBestSeats(seatMap, ticketCount, 5);
  } catch {
    suggestions = [];
  }
  return {
    ...seatMap,
    suggestions,
    bestLabel: suggestions.length ? describeSuggestion(suggestions[0]) : null,
  };
}

function safeScore(seatMap, ticketCount) {
  try {
    return bestScore(seatMap, ticketCount);
  } catch {
    return null;
  }
}

/**
 * The hall as one character per grid cell, for the hover preview.
 *
 * The scan already holds the full grid at this point and then throws it away,
 * so a preview costs nothing to produce and nothing extra to fetch — which
 * matters, because hovering must never trigger a seat request: each one is
 * three upstream calls and a transient cart.
 *
 * Rows are joined with "|" and spacer rows appear as empty segments, so the
 * aisles survive. Measured on real halls this is 84–338 bytes, ~600 at the
 * 15x39 worst case.
 *
 * Deliberately encoded in source order (rows back-first, columns as they
 * arrive). The screen-at-top rotation belongs to the renderer, so exactly one
 * place knows the display convention and the preview cannot drift out of step
 * with the full map.
 */
export function encodePreview(seatMap, suggestions) {
  const picked = new Set();
  for (const s of suggestions ?? []) {
    for (const seat of s.seats) picked.add(`${seat.rowLetter}-${seat.seatNumber}`);
  }

  return seatMap.rows
    .map((row) =>
      row.isSpacer
        ? ''
        : row.cells
            .map((c) => {
              if (!c) return '.'; // gap or aisle
              if (picked.has(`${c.rowLetter}-${c.seatNumber}`)) return '*';
              if (c.state === 'occupied') return '#';
              if (c.state === 'handicapped') return 'h';
              return c.selectable ? 'o' : 'x'; // free, or free but wrong category
            })
            .join(''),
    )
    .join('|');
}

/**
 * Score every showtime given.
 *
 * There is deliberately no small cap: scanning all showtimes of one film at one
 * cinema on one date is the point. `maxScanSessions` is only a runaway guard.
 *
 * Showtimes are grouped by format first, and each group is seeded by fetching
 * its first showtime — that one call learns the group's ticket types, and the
 * rest of the group can then use the cheap minted-token path. Groups run
 * concurrently; within a group the seed goes first.
 *
 * @param {object[]} showtimes from parseSessions()
 * @param {number} ticketCount
 * @param {(done:number,total:number,latest:object)=>void} [onProgress]
 * @param {{aborted:boolean}} [signal]
 */
export async function scanShowtimes(showtimes, ticketCount, onProgress, signal) {
  const targets = showtimes.slice(0, search.maxScanSessions);
  const total = targets.length;
  const results = [];
  let done = 0;

  const report = (entry) => {
    results.push(entry);
    done++;
    onProgress?.(done, total, entry);
  };

  const runOne = async (showtime, hintTicketTypes) => {
    if (signal?.aborted) return null;
    try {
      const seatMap = await getSeats({
        cinemaCode: showtime.cinemaCode,
        sessionId: showtime.sessionId,
        ticketCount,
        hintTicketTypes,
      });
      const entry = {
        ...showtime,
        available: seatMap.available,
        total: seatMap.totalSeats,
        rowCount: seatMap.rowCount,
        maxRowWidth: seatMap.maxRowWidth,
        bestScore: seatMap.bestScore,
        bestLabel: seatMap.bestLabel,
        suggestions: seatMap.suggestions,
        ticketTypes: seatMap.ticketTypes,
        fromCache: seatMap.fromCache,
        // Lets the UI show the hall on hover without another request.
        preview: encodePreview(seatMap, seatMap.suggestions),
        error: null,
      };
      report(entry);
      return seatMap.ticketTypes;
    } catch (err) {
      // Three outcomes must stay distinguishable: a good hall, a showtime with
      // nothing on sale, and a scrape that failed. The UI must never render the
      // last two as "sold out".
      report({
        ...showtime,
        available: null,
        total: null,
        bestScore: null,
        suggestions: [],
        unavailable: Boolean(err.unavailable),
        error: err.message,
      });
      return null;
    }
  };

  // Group by the site's own format label + technology, since showtimes sharing
  // one almost always share a hall type and therefore ticket types.
  const groups = new Map();
  for (const s of targets) {
    const key = `${s.technologies.join(',')}|${s.label}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  await Promise.all(
    [...groups.values()].map(async (group) => {
      const hint = await runOne(group[0], null); // seeds the group's ticket types
      if (group.length === 1 || signal?.aborted) return;
      await Promise.all(group.slice(1).map((s) => runOne(s, hint)));
    }),
  );

  results.sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1));
  return results;
}
