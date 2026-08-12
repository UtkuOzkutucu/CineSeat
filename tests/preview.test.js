/**
 * The hover-preview encoder.
 *
 * Worth testing because a wrong character doesn't crash — it draws a plausible
 * but false picture of the hall, which is exactly the kind of silent wrongness
 * the rest of this codebase is built to avoid. Every assertion here compares
 * the encoding against the parsed map it came from.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePreview } from '../src/seats.js';
import { parseSeatMap } from '../src/parse/seatmap.js';
import { findBestSeats } from '../src/algo/seatDetection.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (f) => parseSeatMap(readFileSync(join(FIXTURES, f), 'utf8'));

const HALLS = ['seatmap-small.html', 'seatmap-medium.html', 'seatmap-large.html'];

describe('preview encoding', () => {
  for (const file of HALLS) {
    test(`${file}: one character per grid cell, aisles preserved`, () => {
      const map = load(file);
      const strips = encodePreview(map, []).split('|');

      assert.equal(strips.length, map.rows.length, 'a segment per row, spacers included');

      map.rows.forEach((row, i) => {
        if (row.isSpacer) {
          assert.equal(strips[i], '', 'spacer rows must stay empty so aisles survive');
        } else {
          assert.equal(strips[i].length, row.cells.length, `row ${row.rowLetter} width`);
        }
      });
    });

    test(`${file}: character counts match the parsed map`, () => {
      const map = load(file);
      const chars = [...encodePreview(map, [])].filter((c) => c !== '|');
      const count = (c) => chars.filter((x) => x === c).length;

      assert.equal(count('#'), map.occupied, 'occupied');
      assert.equal(count('h'), map.handicapped, 'accessible');
      // Available splits into bookable (o) and wrong-category (x).
      assert.equal(count('o') + count('x'), map.available, 'available');
      assert.equal(count('#') + count('h') + count('o') + count('x'), map.totalSeats, 'total');
    });

    test(`${file}: * marks exactly the suggested seats`, () => {
      const map = load(file);
      const suggestions = findBestSeats(map, 2, 1);
      const expected = suggestions.flatMap((s) => s.seats);
      const encoded = encodePreview(map, suggestions);

      assert.equal(
        [...encoded].filter((c) => c === '*').length,
        expected.length,
        'one star per suggested seat',
      );

      // ...and in the right places, not merely the right number.
      const strips = encoded.split('|');
      for (const seat of expected) {
        const rowIndex = map.rows.findIndex((r) => !r.isSpacer && r.rowLetter === seat.rowLetter);
        const col = map.rows[rowIndex].cells.findIndex(
          (c) => c && c.seatNumber === seat.seatNumber,
        );
        assert.equal(
          strips[rowIndex][col],
          '*',
          `${seat.rowLetter}-${seat.seatNumber} should be starred`,
        );
      }
    });
  }

  test('stays small enough to ship with every scan result', () => {
    // The whole point is that it rides along on the existing stream. If a hall
    // ever encoded into kilobytes, sending it per showtime would stop being free.
    for (const file of HALLS) {
      const bytes = Buffer.byteLength(encodePreview(load(file), []));
      assert.ok(bytes < 1024, `${file} encoded to ${bytes} bytes`);
    }
  });

  test('no suggestions means no stars, not a crash', () => {
    const encoded = encodePreview(load('seatmap-small.html'), []);
    assert.ok(!encoded.includes('*'));
    assert.equal(encodePreview(load('seatmap-small.html'), undefined).includes('*'), false);
  });
});
