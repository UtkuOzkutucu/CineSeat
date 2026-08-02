/**
 * Capture real responses as test fixtures.
 *
 *   npm run capture:fixtures
 *
 * Run this whenever the upstream site changes shape. The parsers throw loudly
 * rather than return empty, so a structural change shows up as a failing test
 * instead of an app that silently finds nothing — which is exactly how the
 * original seat-map bug stayed hidden.
 *
 * Deliberately looks for a date containing an after-midnight showtime, since
 * that is the case the date handling turns on, and captures seat maps from three
 * differently sized halls, since the ranking has to hold from 7x9 up to 15x39.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from '../src/config.js';
import { get, postModel, postJson } from '../src/net/client.js';
import { parseUserSessionId, parseTicketTypes } from '../src/parse/ticket.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(DIR, { recursive: true });

const save = (name, body) => {
  writeFileSync(join(DIR, name), body, 'utf8');
  console.log(`  ${name.padEnd(24)} ${(body.length / 1024).toFixed(1)} KB`);
};
const referer = (code, sid) => ({
  Referer: `${BASE_URL}/biletleme/~step~ticket~code~${code}~session~${sid}`,
});

const manifest = { capturedAt: new Date().toISOString(), notes: {} };

console.log('\nCatalogue');

const cinemasJson = await postJson('/Cinema/GetCinemaListsByFilter', { Latitude: 0, Longitude: 0 });
save('cinemas.json', JSON.stringify(cinemasJson, null, 2));
manifest.notes.cinemas = `${cinemasJson.Cinemas.length} cinemas`;

save('cities.json', JSON.stringify(await postJson('/SiteGroup/GetSiteGroupsByFilter', {}), null, 2));

const mavi = cinemasJson.Cinemas.find((c) => /MaviBah/i.test(c.Title)) ?? cinemasJson.Cinemas[0];
const filmsJson = await postJson('/Film/GetAllowedSalesFilmsByFilter', { CinemaIds: [mavi.Id] });
save('films.json', JSON.stringify(filmsJson, null, 2));

const film = filmsJson.find((f) => /rümcek/i.test(f.Title)) ?? filmsJson[0];
manifest.notes.film = `${film.Title} @ ${mavi.Title}`;

const datesHtml = await postModel(
  '/Film/GetFilmSessionDatesView',
  { ScheduledFilmIds: [film.Id], CinemaIds: [mavi.Id] },
  { expect: 'html-optional' },
);
save('session-dates.html', datesHtml);

const dateIds = [...datesHtml.matchAll(/id="date-(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
let chosen = null;
for (const date of dateIds.slice(0, 4)) {
  const html = await postModel(
    '/Film/GetFilmSessionsView',
    { FilmIds: [film.Id], CinemaIds: [mavi.Id], Dates: [date] },
    { expect: 'html-optional' },
  );
  const hasNextDay = [...html.matchAll(/id="showtime-(\d{8})/g)].some(
    (m) => m[1] !== date.replaceAll('-', ''),
  );
  if (!chosen || hasNextDay) chosen = { date, html, hasNextDay };
  if (hasNextDay) break;
}
save('sessions.html', chosen.html);
manifest.notes.sessions = `${chosen.date}${chosen.hasNextDay ? ' (has an after-midnight showtime)' : ''}`;
manifest.notes.sessionsDate = chosen.date;

console.log('\nTicket step + seat maps');

// Seat-map candidates come from every date, not just the one saved above: the
// next-day date is often a quiet one, and we need three differently sized halls.
const candidates = [];
const seen = new Set();
for (const date of [chosen.date, ...dateIds.filter((d) => d !== chosen.date).slice(0, 3)]) {
  const html =
    date === chosen.date
      ? chosen.html
      : await postModel(
          '/Film/GetFilmSessionsView',
          { FilmIds: [film.Id], CinemaIds: [mavi.Id], Dates: [date] },
          { expect: 'html-optional' },
        );
  for (const [, code, sid] of html.matchAll(/code~(\d+)~session~(\d+)/g)) {
    if (seen.has(sid)) continue;
    seen.add(sid);
    candidates.push([null, code, sid]);
  }
}

const found = candidates;
save('ticket-step.html', await get(`/biletleme/~step~ticket~code~${found[0][1]}~session~${found[0][2]}`));

const halls = [];
for (const [, code, sid] of found) {
  if (halls.length >= 3) break;
  try {
    const page = await get(`/biletleme/~step~ticket~code~${code}~session~${sid}`);
    const uid = parseUserSessionId(page);
    const types = parseTicketTypes(page);

    const add = await postModel(
      '/Ticketing/AddTicketWithConcession',
      {
        CinemaId: code,
        SessionId: sid,
        UserSessionId: uid,
        TicketTypes: [{ TicketTypeCode: types[0].code, Qty: 2 }],
      },
      { expect: 'json', headers: referer(code, sid) },
    );
    if (JSON.parse(add).Result !== 0) continue;

    const seatHtml = await postModel(
      '/Ticketing/BookingSeat',
      { CinemaCode: code, SessionId: sid, UserSessionId: uid },
      { headers: referer(code, sid) },
    );
    const seats = (seatHtml.match(/class="seat"/g) ?? []).length;
    if (seats && !halls.some((h) => h.seats === seats)) halls.push({ seats, html: seatHtml });
  } catch {
    // Some showtimes have nothing on sale — just try the next one.
  }
}

halls.sort((a, b) => a.seats - b.seats);
['seatmap-small.html', 'seatmap-medium.html', 'seatmap-large.html'].forEach((name, i) => {
  if (!halls[i]) return;
  save(name, halls[i].html);
  manifest.notes[name] = `${halls[i].seats} seats`;
});

writeFileSync(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\n${JSON.stringify(manifest, null, 2)}\n`);
process.exit(0);
