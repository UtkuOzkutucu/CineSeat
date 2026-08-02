/**
 * The single place for every tunable.
 *
 * IMPORTANT: nothing site-derived belongs here. Ticket codes, prices, seat
 * categories, cinema codes, city names, technology labels and bookable dates
 * all vary per cinema and change over time — they are always fetched, never
 * configured. (Verified: ticket code 0002 is 355 TL in Kocaeli but 400 TL in
 * Ankara; Gold Class halls use seat category 0000000010/0000000012, not
 * 0000000001.)
 *
 * What lives here is only our own policy: how hard we hit the site, how long we
 * cache, when we back off.
 */

export const BASE_URL = 'https://www.paribucineverse.com';

export const http = {
  /**
   * Two lanes.
   *
   * `interactive` is for work a person is waiting on — catalogue panels and
   * seat scans. It is deliberately fast, because these are short bounded
   * bursts, not a crawl.
   *
   * `background` is for the follow-list refresh, the only thing that runs
   * without someone watching. It stays slow.
   */
  lanes: {
    interactive: { concurrency: 6, minDelayMs: 200 },
    background: { concurrency: 1, minDelayMs: 1200 },
  },

  timeoutMs: 20_000,
  maxAttempts: 3,
  retryBaseMs: 1200,

  /**
   * The upstream answers "200 OK" with an 8-byte body (\r\n\r\n\r\n\r\n) when a
   * request is well-formed but server-side state isn't ready. That is a
   * failure. Treating it as success is what silently broke every seat map in
   * the first build. JSON endpoints can legitimately answer smaller, so this
   * threshold only applies to HTML responses.
   */
  minHtmlBytes: 64,

  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  acceptLanguage: 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * Safety rail. Running the interactive lane fast is fine until the site starts
 * pushing back; then continuing would risk a block. On a 429/403 or a run of
 * failures the interactive lane demotes itself to background pacing, says so in
 * the status view, and recovers on its own.
 */
export const backoff = {
  consecutiveFailuresBeforeDemote: 3,
  demoteForMs: 15 * 60 * 1000,
};

export const cache = {
  /** Seat maps go stale fast — people are booking against them live. */
  seatTtlSeconds: 90,

  /**
   * Catalogue responses are live-fetched; this only stops re-clicking a panel
   * from re-requesting within a few seconds. Deliberately short — the whole
   * point of dropping the local database was that nothing goes stale.
   */
  catalogueTtlSeconds: 20,

  /** The technology vocabulary is effectively static. */
  technologyTtlSeconds: 12 * 60 * 60,
};

export const follows = {
  /** How often followed showtimes get their seat counts refreshed. */
  refreshIntervalMs: 10 * 60 * 1000,
  maxItems: 30,
};

export const search = {
  defaultTicketCount: 2,
  maxTicketCount: 10,

  /**
   * A guard against a pathological response, not a feature cap. Scanning every
   * showtime of one film at one cinema on one date is the intended behaviour;
   * that is normally 2-12 and this only stops a runaway.
   */
  maxScanSessions: 60,
};

export const server = {
  port: Number(process.env.PORT) || 3000,
};
