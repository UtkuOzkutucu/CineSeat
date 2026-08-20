/**
 * Parser tests against real captured responses.
 *
 * These exist because the first build failed silently: a parser returned `[]`,
 * the empty result was cached, and the UI showed it as "no seats". Every test
 * here asserts a parser either produces real data or throws — never that it
 * quietly returns nothing.
 *
 * Refresh the fixtures with:  npm run capture:fixtures
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSessions, parseSessionDates, parseTechnologies } from '../src/parse/sessions.js';
import { parseSeatMap } from '../src/parse/seatmap.js';
import {
  parseUserSessionId,
  parseTicketTypes,
  SessionUnavailableError,
} from '../src/parse/ticket.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (n) => readFileSync(join(DIR, n), 'utf8');
const json = (n) => JSON.parse(read(n));
const manifest = json('manifest.json');

describe('cinema list (JSON)', () => {
  const cinemas = json('cinemas.json').Cinemas;

  test('every cinema has the fields the app depends on', () => {
    assert.ok(cinemas.length > 50, `only ${cinemas.length} cinemas`);
    for (const c of cinemas) {
      assert.ok(c.Id, 'Id');
      assert.ok(c.Title, 'Title');
      // The numeric code the whole seat flow runs on. The first build had to
      // discover this one cinema at a time; here it arrives with the list.
      assert.match(c.VistaCinemaId ?? '', /^\d{10}$/, `${c.Title} VistaCinemaId`);
      assert.ok(c.SiteGroupId, `${c.Title} SiteGroupId`);
      assert.ok(Number.isFinite(Number(c.Latitude)), `${c.Title} latitude`);
      assert.ok(Number.isFinite(Number(c.Longitude)), `${c.Title} longitude`);
    }
  });

  test('sitegroups resolve a city for every cinema', () => {
    const cityBy = Object.fromEntries(json('cities.json').map((g) => [g.Value, g.Text]));
    const unresolved = cinemas.filter((c) => !cityBy[c.SiteGroupId]);
    assert.equal(unresolved.length, 0, `unresolved: ${unresolved.map((c) => c.Title).join(', ')}`);
  });

  test('technologies carry both a slug and a display label', () => {
    const withTech = cinemas.filter((c) => (c.Technologies ?? []).length);
    assert.ok(withTech.length > 0, 'no cinema reported any technology');
    for (const c of withTech) {
      for (const t of c.Technologies) {
        assert.ok(t.Identifier, `${c.Title} technology identifier`);
        assert.ok(t.Title, `${c.Title} technology label`);
      }
    }
  });

  test('premium halls exist, so no seat category may be assumed', () => {
    // A reminder in test form: 0000000001 is not "the" seat category. Gold Class
    // halls use others, and hardcoding it silently breaks them.
    const gold = cinemas.filter((c) =>
      (c.Technologies ?? []).some((t) => t.Identifier === 'goldclass'),
    );
    assert.ok(gold.length > 0, 'expected at least one Gold Class cinema');
  });
});

describe('film list (JSON)', () => {
  test('films have an id and a title', () => {
    const films = json('films.json');
    assert.ok(films.length > 0);
    for (const f of films) {
      assert.ok(f.Id, 'Id');
      assert.ok(f.Title, 'Title');
    }
  });

  test('the pre-sale flag is spelled the way the code reads it', () => {
    // IsPreSaleS, plural. Reading the singular gave undefined on every film, so
    // Boolean() made it false and the "Ön Satış" filter matched nothing —
    // no error, just an empty tab. A renamed field must fail here instead.
    const films = json('films.json');
    for (const f of films) {
      assert.ok(
        Object.hasOwn(f, 'IsPreSales'),
        `${f.Title}: expected IsPreSales; keys were ${Object.keys(f).join(', ')}`,
      );
      assert.equal(typeof f.IsPreSales, 'boolean', `${f.Title}: IsPreSales should be a boolean`);
    }
  });
});

describe('session dates', () => {
  const dates = parseSessionDates(read('session-dates.html'));

  test('returns ISO dates in order', () => {
    assert.ok(dates.length > 0, 'no dates parsed');
    for (const d of dates) assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    const sorted = [...dates].map((d) => d.date).sort();
    assert.deepEqual(dates.map((d) => d.date), sorted);
  });

  test('no duplicates', () => {
    assert.equal(new Set(dates.map((d) => d.date)).size, dates.length);
  });
});

describe('sessions fragment', () => {
  const date = manifest.notes.sessionsDate;
  const { groups, showtimes } = parseSessions(read('sessions.html'), date);

  test('groups showtimes the way the site groups them', () => {
    assert.ok(groups.length > 0, 'no groups parsed');
    for (const g of groups) {
      assert.ok(g.label.length > 0, 'group label');
      assert.ok(g.showtimes.length > 0, 'group has showtimes');
      assert.ok(!g.label.endsWith(':'), `label still has its separator: ${g.label}`);
    }
  });

  test('every showtime carries what the seat flow needs', () => {
    assert.ok(showtimes.length > 0);
    for (const s of showtimes) {
      assert.match(s.cinemaCode, /^\d{10}$/);
      assert.match(s.sessionId, /^\d+$/);
      assert.match(s.time, /^\d{1,2}:\d{2}$/);
      assert.match(s.startsAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
  });

  test('showtimes sort by real start time, not by clock face', () => {
    const times = showtimes.map((s) => s.startsAt);
    assert.deepEqual(times, [...times].sort());
  });

  test('after-midnight showtimes are dated to the following day', () => {
    const late = showtimes.filter((s) => s.isNextDay);
    assert.ok(late.length > 0, 'fixture should contain an after-midnight showtime');
    for (const s of late) {
      // A 01:30 listed under the 2nd belongs to the 3rd, and the site's own
      // element id says so. This is what stops the date being misread.
      assert.notEqual(s.showDate, date);
      assert.ok(s.startsAt > `${date}T23:59:59`, `${s.time} should start after the listed day`);
      assert.ok(s.warning, 'the site supplies wording for this case; keep it');
      assert.match(s.warning, /gece/i);
    }
  });

  test('same-day showtimes are not flagged', () => {
    for (const s of showtimes.filter((x) => !x.isNextDay)) assert.equal(s.showDate, date);
  });

  test('an empty fragment means "no showtimes", not a failure', () => {
    const empty = parseSessions('', '2026-01-01');
    assert.deepEqual(empty.groups, []);
    assert.deepEqual(empty.showtimes, []);
  });

  test('unrecognisable markup throws instead of reporting nothing', () => {
    assert.throws(() => parseSessions('<div>bilinmeyen</div>', '2026-01-01'), /çözümlenemedi/);
  });
});

describe('technology vocabulary', () => {
  test('parses without throwing when the filter is absent', () => {
    assert.equal(typeof parseTechnologies(read('ticket-step.html')), 'object');
  });
});

describe('ticket step', () => {
  const html = read('ticket-step.html');

  test('finds a 32-char session token', () => {
    assert.match(parseUserSessionId(html), /^[0-9a-f]{32}$/i);
  });

  test('reads ticket types with prices, cheapest first', () => {
    const types = parseTicketTypes(html);
    assert.ok(types.length > 0);
    for (const t of types) {
      assert.match(t.code, /^\d+$/);
      assert.ok(t.category_cc, 'seat category');
      assert.ok(t.price > 0, `${t.code} price`);
    }
    const prices = types.map((t) => t.price_minor);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  });

  test('a showtime with nothing on sale is not treated as a failure', () => {
    const notOnSale = `<div class="empty-data-content">
      Bu seansa uygun bilet tipi bulunamadı, dilerseniz farklı bir seans seçimi
      yapabilirsiniz. Seans Seçimine Dön</div>`;
    assert.throws(() => parseUserSessionId(notOnSale), SessionUnavailableError);
    assert.throws(
      () => parseTicketTypes(notOnSale),
      (err) => {
        assert.ok(err.unavailable, 'should be flagged unavailable, not a generic error');
        assert.match(err.message, /bilet tipi bulunamadı/i);
        assert.ok(!/Seans Seçimine Dön/.test(err.message), 'trailing link text should be trimmed');
        return true;
      },
    );
  });

  test('genuinely broken markup still throws a plain error', () => {
    assert.throws(
      () => parseUserSessionId('<div>hiçbir şey</div>'),
      (err) => {
        assert.ok(!err.unavailable);
        return true;
      },
    );
  });
});

describe('seat maps across hall sizes', () => {
  const halls = [
    ['seatmap-small.html', 'small'],
    ['seatmap-medium.html', 'medium'],
    ['seatmap-large.html', 'large'],
  ];

  for (const [file, name] of halls) {
    test(`${name}: counts add up`, () => {
      const map = parseSeatMap(read(file));
      assert.ok(map.totalSeats > 0);
      assert.equal(
        map.available + map.occupied + map.handicapped,
        map.totalSeats,
        'states should partition the seats',
      );
      assert.ok(map.rowCount > 0);
      assert.ok(map.maxRowWidth > 0);
      assert.match(map.allowedCc ?? '', /^\d{10}$/);
      assert.equal(map.allocatedSeatCount, 2, 'fixtures were captured with 2 tickets');
    });

    test(`${name}: spacer rows are marked and excluded from the row count`, () => {
      const map = parseSeatMap(read(file));
      const spacers = map.rows.filter((r) => r.isSpacer);
      // Real halls have a horizontal aisle, and data-r skips it, so counting it
      // as a row would shift every depth calculation.
      assert.ok(spacers.length >= 1, 'expected at least one spacer row');
      assert.equal(map.rowCount, map.rows.length - spacers.length);
      for (const s of spacers) assert.equal(s.cells.filter(Boolean).length, 0);
    });

    test(`${name}: row index 0 is the back row`, () => {
      const map = parseSeatMap(read(file));
      const seated = map.rows.filter((r) => !r.isSpacer && r.rowIndex !== null);
      assert.equal(seated[0].rowIndex, 0);
      // Letters descend from the back of the hall toward the screen.
      assert.ok(seated[0].rowLetter > seated[seated.length - 1].rowLetter);
    });

    test(`${name}: only seats in the allowed category are selectable`, () => {
      const map = parseSeatMap(read(file));
      for (const row of map.rows) {
        for (const cell of row.cells) {
          if (!cell?.selectable) continue;
          assert.equal(cell.state, 'available');
          assert.equal(cell.categoryCode, map.allowedCc);
        }
      }
    });
  }

  test('the three fixtures really are different sizes', () => {
    const sizes = halls.map(([f]) => parseSeatMap(read(f)).totalSeats);
    assert.equal(new Set(sizes).size, 3, `sizes were ${sizes.join(', ')}`);
    assert.ok(Math.max(...sizes) / Math.min(...sizes) >= 2, 'need a real spread to test ranking');
  });

  test('a response with no seat table throws — it is never an empty hall', () => {
    // The exact failure the first build swallowed: BookingSeat answers 200 with
    // an empty body when no ticket was registered.
    assert.throws(() => parseSeatMap('\r\n\r\n\r\n\r\n'), /seatContainer/);
    assert.throws(
      () => parseSeatMap('<table id="seatContainer"><tbody></tbody></table>'),
      /koltuk yok/,
    );
  });
});
