/**
 * Parse the HTML fragments returned by /Film/GetFilmSessionsView and
 * /Film/GetFilmSessionDatesView.
 *
 * The sessions fragment is already grouped the way the real booking page shows
 * it — one group per hall technology + format combination — so we keep that
 * grouping rather than inventing our own:
 *
 *   <div data-type="date">
 *     <div class="ticket-flow-card-movie-techs">
 *       <div class="tech-item" data-technologies="imax"><img src=".../IMAX.svg"></div>
 *       <span class="ticket-flow-movie-subtitle">ALTY :</span>
 *     </div>
 *     <div id="showtime-20260802220000" data-session-available="True" data-warning=""
 *          data-href="/biletleme/~step~ticket~code~0000000088~session~196848">22:00</div>
 *     <div id="showtime-20260803013000"
 *          data-warning="Seçtiğin seans 2.08.2026 tarihini 3.08.2026 tarihine bağlayan geceye aittir."
 *          data-href="...session~197226">01:30</div>
 *   </div>
 *
 * Two things worth noting, because they solve problems we would otherwise have
 * had to solve badly ourselves:
 *
 *   - The element id carries the *true* start datetime. A 01:30 showtime listed
 *     under 2 August has id ...20260803013000 — the site already dates it to the
 *     3rd. That is how we detect an after-midnight session, rather than guessing
 *     from a bare "01:30".
 *   - `data-warning` is the site's own Turkish wording for that case. We show it
 *     verbatim instead of writing our own.
 */

import * as cheerio from 'cheerio';

/**
 * @param {string} html fragment from GetFilmSessionsView
 * @param {string} requestedDate the date we asked for, "YYYY-MM-DD"
 * @returns {{groups: object[], showtimes: object[]}} groups preserve the site's
 *   own ordering; showtimes is the same data flattened and sorted by start time
 */
export function parseSessions(html, requestedDate) {
  const $ = cheerio.load(html);
  const groups = [];
  const showtimes = [];

  $('[data-type="date"]').each((_, el) => {
    const $group = $(el);

    const technologies = [];
    $group.find('.tech-item[data-technologies]').each((__, t) => {
      const slug = ($(t).attr('data-technologies') || '').trim();
      if (slug) technologies.push(slug);
    });

    // e.g. "2D - ALTY :" or "ALTY :" — the site's own label. Strip the trailing
    // colon it uses as a separator, but otherwise show what they show.
    const label = ($group.find('.ticket-flow-movie-subtitle').first().text() || '')
      .replace(/\s*:\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    const groupShowtimes = [];

    $group.find('[id^="showtime-"]').each((__, s) => {
      const $s = $(s);
      const id = $s.attr('id') || '';
      const href = $s.attr('data-href') || '';
      const match = href.match(/code~(\d+)~session~(\d+)/);
      if (!match) return;

      const startsAt = parseShowtimeId(id);
      const dateOfShow = startsAt ? startsAt.slice(0, 10) : requestedDate;

      const showtime = {
        cinemaCode: match[1],
        sessionId: match[2],
        time: $s.text().replace(/\s+/g, ' ').trim(),
        startsAt, // "YYYY-MM-DDTHH:MM:00" local, or null if the id was odd
        showDate: dateOfShow,
        requestedDate,
        // True when the site itself dates this later than the day it's listed
        // under — i.e. it runs past midnight.
        isNextDay: Boolean(startsAt) && dateOfShow !== requestedDate,
        warning: ($s.attr('data-warning') || '').trim() || null,
        available: ($s.attr('data-session-available') || '').toLowerCase() === 'true',
        dataUrl: href,
        technologies,
        label,
      };

      groupShowtimes.push(showtime);
      showtimes.push(showtime);
    });

    if (groupShowtimes.length) {
      groups.push({ label, technologies, showtimes: groupShowtimes });
    }
  });

  if (groups.length === 0 && html.trim().length > 0) {
    throw new Error(
      'Seans listesi çözümlenemedi — [data-type="date"] grupları bulunamadı. ' +
        'GetFilmSessionsView yanıtının yapısı değişmiş olabilir.',
    );
  }

  showtimes.sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''));
  return { groups, showtimes };
}

/** "showtime-20260803013000" → "2026-08-03T01:30:00" */
function parseShowtimeId(id) {
  const m = id.match(/^showtime-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/**
 * Dates fragment from GetFilmSessionDatesView.
 *
 *   <div id="date-2026-08-02" data-full-date="02-08-2026" data-month-long-name="Ağustos" …>
 *
 * @returns {{date: string, label: string}[]} date is ISO "YYYY-MM-DD"
 */
export function parseSessionDates(html) {
  const $ = cheerio.load(html);
  const dates = [];
  const seen = new Set();

  $('[id^="date-"]').each((_, el) => {
    const $el = $(el);
    const iso = ($el.attr('id') || '').replace(/^date-/, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || seen.has(iso)) return;
    seen.add(iso);

    dates.push({
      date: iso,
      day: ($el.attr('data-date-today') || '').trim() || null,
      month: ($el.attr('data-month-long-name') || '').trim() || null,
      label: $el.text().replace(/\s+/g, ' ').trim() || null,
    });
  });

  return dates;
}

/**
 * The technology vocabulary, from the site's own filter dropdown on /sinemalar.
 * Scraped rather than hardcoded so new hall types appear on their own.
 *
 * @returns {Record<string,string>} slug → display label, e.g. imax → "IMAX"
 */
export function parseTechnologies(html) {
  const $ = cheerio.load(html);
  const map = {};

  $('select#technologies option').each((_, el) => {
    const value = ($(el).attr('value') || '').trim();
    const label = $(el).text().trim();
    if (!value || !label) return;
    if (value.toLowerCase() === 'all') return;
    if (value === label) return; // the placeholder option
    map[value.toLowerCase()] = label;
  });

  return map;
}
