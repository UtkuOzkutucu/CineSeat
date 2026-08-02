/**
 * Everything the app asks of paribucineverse.com.
 *
 * The catalogue comes from the JSON/view endpoints the real booking page uses,
 * not from scraping rendered pages. Four small calls cover the whole
 * drill-down, and they filter in both directions — pass CinemaIds to get that
 * cinema's films, or ScheduledFilmIds to get the cinemas showing that film. That
 * is why there is no local catalogue and no background crawler any more.
 *
 *   POST /Cinema/GetCinemaListsByFilter      { Latitude, Longitude, ScheduledFilmIds[] }
 *   POST /Film/GetAllowedSalesFilmsByFilter  { CinemaIds[] }
 *   POST /Film/GetFilmSessionDatesView       { ScheduledFilmIds[], CinemaIds[] }
 *   POST /Film/GetFilmSessionsView           { FilmIds[], CinemaIds[], Dates[] }
 *
 * Seat maps still need the four-step booking flow, which is the one expensive
 * part and the only thing that writes anything upstream.
 */

import { get, postJson, postModel, request } from './client.js';
import { parseSessions, parseSessionDates, parseTechnologies } from '../parse/sessions.js';
import { parseUserSessionId, parseTicketTypes } from '../parse/ticket.js';
import { parseSeatMap } from '../parse/seatmap.js';
import { cache, BASE_URL } from '../config.js';

// ─── Tiny in-memory cache ─────────────────────────────────────────────────────
// Just enough to stop re-clicking a panel from re-requesting. Nothing is
// persisted — the point of dropping the database was that nothing goes stale.

const memo = new Map();

async function cached(key, ttlSeconds, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlSeconds * 1000) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

export function clearCache() {
  memo.clear();
}

// ─── Catalogue ────────────────────────────────────────────────────────────────

/**
 * Every cinema, optionally narrowed to those showing a given film.
 *
 * The response carries what the old scraper worked hard for: VistaCinemaId is
 * the numeric cinema code (previously discovered one cinema at a time from a
 * showtime link), and Distance is computed server-side from the coordinates we
 * pass, which is all "Yakınımdakiler" needs.
 *
 * @param {object} [opts]
 * @param {string} [opts.filmId] upstream film GUID
 * @param {number} [opts.latitude]
 * @param {number} [opts.longitude]
 */
export async function getCinemas({ filmId = null, latitude = 0, longitude = 0 } = {}) {
  const key = `cinemas:${filmId ?? 'all'}:${latitude}:${longitude}`;
  return cached(key, cache.catalogueTtlSeconds, async () => {
    const model = {
      Latitude: latitude,
      Longitude: longitude,
      ...(filmId ? { ScheduledFilmIds: [filmId] } : {}),
    };
    const [json, cityBySiteGroup] = await Promise.all([
      postJson('/Cinema/GetCinemaListsByFilter', model, { lane: 'interactive' }),
      getCities(),
    ]);
    const list = json?.Cinemas ?? [];

    return list.map((c) => ({
      id: c.Id,
      name: c.Title,
      slug: (c.Slug ?? '').replace(/^\//, ''),
      cinemaCode: c.VistaCinemaId ?? null,
      // The JSON's own City field is inconsistent — "Muğla" for one cinema but
      // "KARŞIYAKA / IZMIR" for another. The sitegroup is the clean grouping the
      // site itself uses in its city filter.
      city: cityBySiteGroup[c.SiteGroupId] ?? c.City ?? null,
      address: c.Address ?? null,
      latitude: c.Latitude ? Number(c.Latitude) : null,
      longitude: c.Longitude ? Number(c.Longitude) : null,
      // Only meaningful when real coordinates were supplied.
      distanceKm: latitude || longitude ? (c.Distance ?? null) : null,
      // [{ Id, Identifier: "goldclass", Title: "GOLD CLASS" }, …]
      technologies: (c.Technologies ?? [])
        .map((t) => ({
          slug: String(t?.Identifier ?? '').toLowerCase(),
          label: t?.Title ?? null,
        }))
        .filter((t) => t.slug),
      siteGroupId: c.SiteGroupId ?? null,
    }));
  });
}

/** siteGroupId → city name ("İzmir", "İstanbul Anadolu"). */
export async function getCities() {
  return cached('cities', cache.technologyTtlSeconds, async () => {
    const json = await postJson('/SiteGroup/GetSiteGroupsByFilter', {}, { lane: 'interactive' });
    const map = {};
    for (const g of Array.isArray(json) ? json : []) {
      if (g?.Value && g?.Text) map[g.Value] = g.Text.trim();
    }
    return map;
  });
}

/**
 * Films currently on sale, optionally narrowed to one cinema.
 * @param {object} [opts]
 * @param {string} [opts.cinemaId] upstream cinema GUID
 */
export async function getFilms({ cinemaId = null } = {}) {
  const key = `films:${cinemaId ?? 'all'}`;
  return cached(key, cache.catalogueTtlSeconds, async () => {
    const model = cinemaId ? { CinemaIds: [cinemaId] } : {};
    const json = await postJson('/Film/GetAllowedSalesFilmsByFilter', model, {
      lane: 'interactive',
    });
    const list = Array.isArray(json) ? json : (json?.Films ?? []);

    return list.map((f) => ({
      id: f.Id,
      title: f.Title,
      originalTitle: f.OriginalTitle ?? null,
      slug: (f.Slug ?? '').replace(/^\//, ''),
      posterUrl: absoluteMedia(f.ImageUrl),
      runtimeMin: f.Duration ?? f.RunTime ?? null,
      genre: f.Genre ?? f.GenreName ?? null,
      firstSessionDate: f.FirstAvailableSessionDate ?? null,
      isPreSale: Boolean(f.IsPreSale),
    }));
  });
}

/** Bookable dates for a film at a cinema. */
export async function getDates({ filmId, cinemaId }) {
  const key = `dates:${filmId}:${cinemaId}`;
  return cached(key, cache.catalogueTtlSeconds, async () => {
    const html = await postModel(
      '/Film/GetFilmSessionDatesView',
      { ScheduledFilmIds: [filmId], CinemaIds: [cinemaId] },
      { lane: 'interactive', expect: 'html-optional' },
    );
    return parseSessionDates(html);
  });
}

/**
 * Showtimes for a film at a cinema on a date, grouped by hall technology and
 * format exactly as the site groups them.
 * @param {string} date "YYYY-MM-DD" — the endpoint rejects other formats
 */
export async function getSessions({ filmId, cinemaId, date }) {
  const key = `sessions:${filmId}:${cinemaId}:${date}`;
  return cached(key, cache.catalogueTtlSeconds, async () => {
    // An empty response here is meaningful, not broken: this film has no
    // showtimes at this cinema on this date.
    const html = await postModel(
      '/Film/GetFilmSessionsView',
      { FilmIds: [filmId], CinemaIds: [cinemaId], Dates: [date] },
      { lane: 'interactive', expect: 'html-optional' },
    );
    return parseSessions(html, date);
  });
}

/**
 * slug → display label for hall technologies ("goldclass" → "GOLD CLASS").
 *
 * Derived from the cinema list, which already carries proper labels, so this
 * costs no extra request. The /sinemalar filter dropdown is a fallback only —
 * it exists but renders the labels with worse casing ("Goldclass", "Imax").
 */
export async function getTechnologies() {
  return cached('technologies', cache.technologyTtlSeconds, async () => {
    const cinemas = await getCinemas();
    const map = {};
    for (const c of cinemas) {
      for (const t of c.technologies) {
        if (t.label && !map[t.slug]) map[t.slug] = t.label;
      }
    }
    if (Object.keys(map).length > 0) return map;
    return parseTechnologies(await get('/sinemalar', { lane: 'interactive' }));
  });
}

function absoluteMedia(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return `https://cdn-web.marsgate.tr/255/${url.replace(/^\//, '')}`;
}

// ─── Seat flow ────────────────────────────────────────────────────────────────

function ticketStepPath(cinemaCode, sessionId) {
  return `/biletleme/~step~ticket~code~${cinemaCode}~session~${sessionId}`;
}

/**
 * A UserSessionId, as cheaply as possible.
 *
 * The ticket-step page costs ~56 KB / ~343 ms, but
 * POST /Ticketing/AssignNewUserSessionId mints a fresh token in ~59 bytes /
 * ~36 ms, and a minted token works for a session other than the one it came
 * from (verified). So we pay for the page once per run and mint from there.
 */
let seedToken = null;

async function mintToken() {
  if (!seedToken) return null;
  try {
    const json = await postJson(
      '/Ticketing/AssignNewUserSessionId',
      { UserSessionId: seedToken },
      { lane: 'interactive' },
    );
    if (json?.UserSessionId) {
      seedToken = json.UserSessionId; // chain from the newest token
      return json.UserSessionId;
    }
  } catch {
    // Fall through to the page fetch below; minting is an optimisation only.
  }
  return null;
}

/**
 * Fetch the ticket-step page: the authoritative source for both the token and
 * this session's ticket types. Also seeds the cheap minting path.
 */
export async function fetchTicketStep(cinemaCode, sessionId) {
  const html = await get(ticketStepPath(cinemaCode, sessionId), {
    lane: 'interactive',
    headers: { Referer: `${BASE_URL}/sinemalar` },
  });
  const userSessionId = parseUserSessionId(html);
  seedToken ??= userSessionId;
  return { userSessionId, ticketTypes: parseTicketTypes(html) };
}

/**
 * Register a ticket quantity against the session.
 *
 * Mandatory and easy to miss: without it BookingSeat answers 200 with an empty
 * body and no seat grid ever appears. Creates a transient cart server-side —
 * no login, no payment, no seat held; exactly what a visitor's "devam et" does.
 */
export async function addTicket({ cinemaCode, sessionId, userSessionId, ticketTypeCode, qty }) {
  const text = await postModel(
    '/Ticketing/AddTicketWithConcession',
    {
      CinemaId: cinemaCode,
      SessionId: sessionId,
      UserSessionId: userSessionId,
      TicketTypes: [{ TicketTypeCode: ticketTypeCode, Qty: qty }],
    },
    {
      lane: 'interactive',
      expect: 'json',
      // Without a Referer matching the ticket step this endpoint answers with an
      // HTML error page instead of JSON.
      headers: { Referer: `${BASE_URL}${ticketStepPath(cinemaCode, sessionId)}` },
    },
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`AddTicketWithConcession JSON döndürmedi: ${text.slice(0, 200)}`);
  }
}

/** The live seat grid. Only meaningful after addTicket() has succeeded. */
export async function fetchSeatMap({ cinemaCode, sessionId, userSessionId }) {
  const html = await request('/Ticketing/BookingSeat', {
    lane: 'interactive',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'X-TS-AJAX-Request': 'true',
      Origin: BASE_URL,
      Referer: `${BASE_URL}${ticketStepPath(cinemaCode, sessionId)}`,
    },
    body: new URLSearchParams({
      CinemaCode: cinemaCode,
      SessionId: sessionId,
      UserSessionId: userSessionId,
    }).toString(),
    expect: 'html',
  });
  return parseSeatMap(html);
}

/**
 * The whole seat fetch for one showtime.
 *
 * Fast path: if we already know this session's ticket types, mint a token and
 * skip the 56 KB page. If AddTicket then rejects it — a stale token, or a
 * cached ticket code that doesn't belong to this hall — fall back to the page
 * once and retry. That fallback is what makes the optimisation safe: a wrong
 * guess self-corrects instead of failing.
 *
 * @param {object} args
 * @param {string[]} [args.knownTicketTypes] previously seen types for this session
 */
export async function fetchSeats({
  cinemaCode,
  sessionId,
  ticketCount,
  ticketTypeCode = null,
  knownTicketTypes = null,
}) {
  const attempt = async (viaPage) => {
    let userSessionId;
    let ticketTypes;

    if (!viaPage && knownTicketTypes?.length) {
      const minted = await mintToken();
      if (minted) {
        userSessionId = minted;
        ticketTypes = knownTicketTypes;
      }
    }
    if (!userSessionId) {
      ({ userSessionId, ticketTypes } = await fetchTicketStep(cinemaCode, sessionId));
    }

    const chosen =
      ticketTypes.find((t) => t.code === ticketTypeCode) ?? ticketTypes[0]; // cheapest first

    const result = await addTicket({
      cinemaCode,
      sessionId,
      userSessionId,
      ticketTypeCode: chosen.code,
      qty: ticketCount,
    });

    if (!result || result.Result !== 0) {
      const detail = result?.ErrorDescription || `Result=${result?.Result}`;
      const err = new Error(`Bilet kaydedilemedi (${chosen.code} × ${ticketCount}): ${detail}`);
      err.retryViaPage = true;
      throw err;
    }

    const seatMap = await fetchSeatMap({ cinemaCode, sessionId, userSessionId });
    return { ...seatMap, ticketTypes, ticketTypeCode: chosen.code, ticketCount };
  };

  try {
    return await attempt(false);
  } catch (err) {
    if (!err.retryViaPage) throw err;
    return attempt(true); // authoritative path
  }
}
