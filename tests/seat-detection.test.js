/**
 * Seat detection tests.
 *
 * The algorithm was originally tuned against one 256-seat / 14-row hall. Real
 * halls run from 55 seats / 7 rows / 9 wide up to 456 / 15 / 39 — an 8x spread
 * — which broke two assumptions: narrow rows made almost every seat read as an
 * "edge" seat, and shallow halls let the ideal depth fall between rows.
 *
 * So these tests check the geometry on synthetic halls (where the right answer
 * is known regardless of who happens to have booked what) and check counts on
 * the real fixtures.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBestSeats, bestScore, describeSuggestion } from '../src/algo/seatDetection.js';
import { parseSeatMap } from '../src/parse/seatmap.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const haveFixtures = existsSync(join(FIXTURES, 'seatmap-small.html'));

/**
 * An empty hall, letters descending from the back row (as the site emits it):
 * data-r 0 is the back, 'A' is nearest the screen.
 */
function buildHall(rowCount, width, { spacerAfter = null } = {}) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const rows = [];
  let r = 0;
  for (let i = 0; i < rowCount; i++) {
    const rowLetter = letters[rowCount - 1 - i];
    const cells = Array.from({ length: width }, (_, c) => ({
      rowLetter,
      rowIndex: r,
      colIndex: c,
      seatNumber: c + 1,
      categoryCode: '0000000001',
      state: 'available',
      selectable: true,
    }));
    rows.push({ rowLetter, rowIndex: r, isSpacer: false, cells });
    r++;
    if (spacerAfter !== null && i === spacerAfter) {
      rows.push({ rowLetter: null, rowIndex: null, isSpacer: true, cells: [] });
      r++;
    }
  }
  return { rows };
}

/** Occupy everything except the seats the predicate keeps. */
function keepOnly(hall, predicate) {
  for (const row of hall.rows) {
    for (const cell of row.cells) {
      if (!predicate(cell)) {
        cell.state = 'occupied';
        cell.selectable = false;
      }
    }
  }
  return hall;
}

function depthFraction(hall, suggestion) {
  const seated = hall.rows.filter((r) => !r.isSpacer);
  const idx = seated.findIndex((r) => r.rowLetter === suggestion.rowLetter);
  return idx / (seated.length - 1);
}

const HALLS = [
  ['small 7x9', 7, 9, 3],
  ['medium 11x24', 11, 24, 6],
  ['large 15x39', 15, 39, 11],
];

describe('seats the middle-back sweet spot in every hall shape', () => {
  for (const [name, rows, width, spacer] of HALLS) {
    test(name, () => {
      const hall = buildHall(rows, width, { spacerAfter: spacer });
      const best = findBestSeats(hall, 2, 3)[0];
      assert.ok(best, 'no suggestion produced');

      const depth = depthFraction(hall, best);
      assert.ok(
        depth > 0.15 && depth < 0.5,
        `${name}: picked ${depth * 100}% toward the screen, expected the back-middle band`,
      );

      // ...and horizontally centred.
      const centre = (width - 1) / 2;
      const cols = best.seats.map((s) => s.colIndex);
      const offset = Math.abs((cols[0] + cols[cols.length - 1]) / 2 - centre);
      assert.ok(offset <= width * 0.15, `${name}: picked ${offset} seats off centre`);
    });
  }
});

describe('scores are comparable across hall sizes', () => {
  test('an empty hall of any shape tops out at 1.0', () => {
    for (const [name, rows, width, spacer] of HALLS) {
      const hall = buildHall(rows, width, { spacerAfter: spacer });
      assert.equal(bestScore(hall, 2), 1, `${name} did not reach its own ceiling`);
    }
  });

  test('good seats in a small hall beat poor seats in a huge one', () => {
    // The failure this guards against: raw scores made a mediocre pair in a
    // 456-seat IMAX outrank an excellent pair in a 55-seat hall.
    const small = keepOnly(
      buildHall(7, 9, { spacerAfter: 3 }),
      (c) => c.rowIndex === 2 && c.colIndex >= 3 && c.colIndex <= 5,
    );
    const imax = keepOnly(
      buildHall(15, 39, { spacerAfter: 11 }),
      (c) => c.rowIndex === 15 && c.colIndex <= 3,
    );

    assert.ok(
      bestScore(small, 2) > bestScore(imax, 2),
      'middle-back seats in the small hall should outrank front-corner IMAX seats',
    );
  });

  test('front-row corner seats score poorly in absolute terms', () => {
    const imax = keepOnly(
      buildHall(15, 39, { spacerAfter: 11 }),
      (c) => c.rowIndex === 15 && c.colIndex <= 3,
    );
    assert.ok(bestScore(imax, 2) < 0.4);
  });
});

describe('spacer rows', () => {
  test('do not shift the ideal depth', () => {
    const withSpacer = findBestSeats(buildHall(8, 10, { spacerAfter: 3 }), 2, 1)[0];
    const without = findBestSeats(buildHall(8, 10), 2, 1)[0];
    assert.equal(withSpacer.rowLetter, without.rowLetter);
  });
});

describe('adjacency rules', () => {
  test('never spans an aisle gap', () => {
    const hall = buildHall(5, 9);
    // Punch a gap in the middle of every row.
    for (const row of hall.rows) row.cells[4] = null;

    for (const s of findBestSeats(hall, 3, 5)) {
      const cols = s.seats.map((x) => x.colIndex).sort((a, b) => a - b);
      assert.ok(
        cols.every((c) => c < 4) || cols.every((c) => c > 4),
        `suggestion ${describeSuggestion(s)} spans the aisle`,
      );
    }
  });

  test('never suggests occupied or unselectable seats', () => {
    const hall = keepOnly(buildHall(6, 12), (c) => c.rowIndex >= 2);
    for (const s of findBestSeats(hall, 2, 5)) {
      for (const seat of s.seats) assert.ok(seat.rowIndex >= 2);
    }
  });

  test('returns nothing when no run is long enough', () => {
    const hall = keepOnly(buildHall(5, 9), (c) => c.colIndex === 0); // isolated singles
    assert.deepEqual(findBestSeats(hall, 2, 5), []);
    assert.equal(bestScore(hall, 2), null);
  });

  test('suggestions do not overlap each other', () => {
    const suggestions = findBestSeats(buildHall(10, 20), 2, 5);
    const seen = new Set();
    for (const s of suggestions) {
      for (const seat of s.seats) {
        const key = `${seat.rowLetter}-${seat.seatNumber}`;
        assert.ok(!seen.has(key), `${key} appears in more than one suggestion`);
        seen.add(key);
      }
    }
  });

  test('rejects a nonsensical ticket count', () => {
    assert.throws(() => findBestSeats(buildHall(5, 9), 0), /positive integer/);
    assert.throws(() => findBestSeats(buildHall(5, 9), -1), /positive integer/);
  });
});

describe('describeSuggestion', () => {
  test('states the answer in words, with seat numbers in order', () => {
    const hall = buildHall(6, 12);
    const best = findBestSeats(hall, 2, 1)[0];
    assert.match(describeSuggestion(best), /^[A-Z] sırası, koltuk \d+-\d+$/);
  });

  test('handles a single ticket', () => {
    const best = findBestSeats(buildHall(6, 12), 1, 1)[0];
    assert.match(describeSuggestion(best), /^[A-Z] sırası, koltuk \d+$/);
  });
});

describe('real fixtures', { skip: haveFixtures ? false : 'run `npm run capture:fixtures`' }, () => {
  for (const file of ['seatmap-small.html', 'seatmap-medium.html', 'seatmap-large.html']) {
    test(`${file} produces coherent suggestions`, () => {
      const map = parseSeatMap(readFileSync(join(FIXTURES, file), 'utf8'));
      const suggestions = findBestSeats(map, 2, 5);

      // Occupancy varies over time, so only assert internal consistency.
      for (const s of suggestions) {
        assert.equal(s.seats.length, 2);
        assert.ok(s.score > 0 && s.score <= 1, `score out of range: ${s.score}`);
        for (const seat of s.seats) {
          const row = map.rows.find((r) => r.rowLetter === seat.rowLetter && !r.isSpacer);
          const cell = row.cells.find((c) => c && c.seatNumber === seat.seatNumber);
          assert.ok(cell.selectable, `suggested an unselectable seat in ${file}`);
        }
      }
    });
  }
});
