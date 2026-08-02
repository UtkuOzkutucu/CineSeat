/**
 * Persistence — one small JSON file.
 *
 * The catalogue is fetched live now, so the only things worth keeping between
 * runs are favourites, follows, a couple of settings, and the ticket types
 * that let the seat fetch skip its expensive page. That is a few kilobytes,
 * which is why this replaced SQLite: dropping the native module also dropped
 * the Electron-vs-Node rebuild problem.
 *
 * Seat maps are deliberately **not** persisted. They are full row-and-cell
 * grids that go stale in 90 seconds, so writing them to disk bought nothing
 * and grew the file to a megabyte during ordinary scanning — which then had to
 * be parsed synchronously at every startup.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write can't leave a
 * truncated file behind.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cache, follows as followCfg, search } from './config.js';

// Electron sets this to its userData directory; standalone `node` falls back to
// ./data next to the source.
const DATA_DIR =
  process.env.CINESEAT_DATA_DIR ||
  join(dirname(fileURLToPath(import.meta.url)), '../data');

const FILE = join(DATA_DIR, 'cineseat.json');
const TMP = `${FILE}.tmp`;

/** Keeps the persisted file bounded; oldest entries are dropped first. */
const MAX_TICKET_TYPES = 500;

const EMPTY = {
  version: 4,
  favourites: [], // cinema ids
  follows: [], // saved showtimes
  settings: {
    ticketCount: search.defaultTicketCount,
    autoScan: true,
    city: null,
  },
  ticketTypes: {}, // "cinemaCode:sessionId" → { at, types }, so the fast path can skip the big page
};

let state = load();

function load() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(FILE)) return structuredClone(EMPTY);
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    const state = {
      ...structuredClone(EMPTY),
      ...parsed,
      settings: { ...EMPTY.settings, ...parsed.settings },
    };
    // Older files persisted seat maps and bare ticket-type arrays. Drop the
    // former and normalise the latter rather than migrating.
    delete state.seats;
    for (const [k, v] of Object.entries(state.ticketTypes)) {
      if (Array.isArray(v)) state.ticketTypes[k] = { at: Date.now(), types: v };
    }
    return state;
  } catch (err) {
    console.warn(`[store] ${FILE} okunamadı, sıfırdan başlanıyor: ${err.message}`);
    return structuredClone(EMPTY);
  }
}

let writeTimer = null;

/** Debounced so a burst of seat writes during a scan doesn't hammer the disk. */
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(TMP, JSON.stringify(state), 'utf8');
      renameSync(TMP, FILE);
    } catch (err) {
      console.warn(`[store] kaydedilemedi: ${err.message}`);
    }
  }, 250);
}

export function storePath() {
  return FILE;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export const settings = {
  all: () => ({ ...state.settings }),
  get: (key) => state.settings[key],
  set(patch) {
    state.settings = { ...state.settings, ...patch };
    save();
    return { ...state.settings };
  },
};

// ─── Favourites ───────────────────────────────────────────────────────────────

export const favourites = {
  list: () => [...state.favourites],
  has: (cinemaId) => state.favourites.includes(cinemaId),
  toggle(cinemaId, on) {
    const isOn = state.favourites.includes(cinemaId);
    const next = on ?? !isOn;
    if (next && !isOn) state.favourites.push(cinemaId);
    if (!next && isOn) state.favourites = state.favourites.filter((id) => id !== cinemaId);
    save();
    return next;
  },
};

// ─── Follows ──────────────────────────────────────────────────────────────────

/**
 * A followed showtime stores everything needed to reopen its seat map directly,
 * because there is no local catalogue to look it up in afterwards.
 */
export const follows = {
  list() {
    const now = new Date().toISOString();
    return state.follows
      .map((f) => ({ ...f, expired: Boolean(f.startsAt) && f.startsAt < now }))
      .sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
  },

  add(entry) {
    const id = `${entry.cinemaCode}:${entry.sessionId}:${entry.ticketCount}`;
    if (state.follows.some((f) => f.id === id)) return false;
    if (state.follows.length >= followCfg.maxItems) {
      throw new Error(`Takip listesi dolu (en fazla ${followCfg.maxItems}).`);
    }
    state.follows.push({ id, addedAt: new Date().toISOString(), ...entry });
    save();
    return true;
  },

  remove(id) {
    const before = state.follows.length;
    state.follows = state.follows.filter((f) => f.id !== id);
    save();
    return state.follows.length < before;
  },

  /** Drop everything already in the past. */
  clearExpired() {
    const now = new Date().toISOString();
    const before = state.follows.length;
    state.follows = state.follows.filter((f) => !f.startsAt || f.startsAt >= now);
    save();
    return before - state.follows.length;
  },

  /** Record the latest seat counts against a follow, for the list view. */
  updateStats(id, stats) {
    const f = state.follows.find((x) => x.id === id);
    if (!f) return;
    Object.assign(f, stats, { checkedAt: new Date().toISOString() });
    save();
  },
};

// ─── Ticket types ─────────────────────────────────────────────────────────────

/**
 * Knowing a session's ticket types is what lets the seat fetch skip the 56 KB
 * ticket page and mint a token instead.
 */
export const ticketTypes = {
  get: (cinemaCode, sessionId) => state.ticketTypes[`${cinemaCode}:${sessionId}`]?.types ?? null,

  set(cinemaCode, sessionId, types) {
    state.ticketTypes[`${cinemaCode}:${sessionId}`] = { at: Date.now(), types };

    // Bounded: a heavy scanning session would otherwise add an entry per
    // showtime forever.
    const keys = Object.keys(state.ticketTypes);
    if (keys.length > MAX_TICKET_TYPES) {
      keys
        .sort((a, b) => state.ticketTypes[a].at - state.ticketTypes[b].at)
        .slice(0, keys.length - MAX_TICKET_TYPES)
        .forEach((k) => delete state.ticketTypes[k]);
    }
    save();
  },
};

// ─── Seat cache ───────────────────────────────────────────────────────────────

/**
 * In memory only, and intentionally so. A seat map is a full row-and-cell grid
 * that is worthless after ~90 seconds; persisting it grew the store to a
 * megabyte and bought nothing, since it always expired before the next launch.
 */
const seatCache = new Map();

const seatKey = (cinemaCode, sessionId, count, type) =>
  `${cinemaCode}:${sessionId}:${count}:${type ?? '-'}`;

export const seats = {
  get(cinemaCode, sessionId, count, type) {
    const hit = seatCache.get(seatKey(cinemaCode, sessionId, count, type));
    if (!hit) return null;
    const ageSeconds = (Date.now() - hit.at) / 1000;
    if (ageSeconds > cache.seatTtlSeconds) return null;
    return { ...hit.data, fromCache: true, ageSeconds: Math.round(ageSeconds) };
  },

  set(cinemaCode, sessionId, count, type, data) {
    seatCache.set(seatKey(cinemaCode, sessionId, count, type), { at: Date.now(), data });
    prune();
  },
};

/** Expired entries are dead weight; drop them whenever we add one. */
function prune() {
  const cutoff = Date.now() - cache.seatTtlSeconds * 1000;
  for (const [k, v] of seatCache) {
    if (v.at < cutoff) seatCache.delete(k);
  }
}

export function stats() {
  return {
    path: FILE,
    favourites: state.favourites.length,
    follows: state.follows.length,
    cachedSeatMaps: seatCache.size,
    knownTicketTypes: Object.keys(state.ticketTypes).length,
  };
}
