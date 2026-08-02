/**
 * Smart Seat Detection
 * ────────────────────
 * Input: the grid from parseSeatMap() — rows of cells, where a cell is either
 * null (aisle/gap — a hard break) or a seat { rowIndex, colIndex, state,
 * selectable }.
 *
 *   1. Build a per-hall desirability weighting (middle-back = best).
 *   2. Slide a window of N seats across every run of adjacent free seats.
 *   3. Score each window, then normalise against the best the hall can offer.
 *   4. Return the top non-overlapping candidates, best first.
 *
 * Hall geometry varies enormously — 55 seats / 7 rows / 9 wide up to 456 seats /
 * 15 rows / 39 wide, an 8x spread. The original version was tuned against a
 * single 256-seat fixture and used absolute scores, which quietly penalised
 * small halls twice over: their rows are narrow (so almost every seat reads as
 * an "edge" seat) and shallow (so the ideal depth can fall between rows).
 * Everything here is therefore expressed relative to the hall it is scoring.
 */

/** Seats physically in the hall, ignoring the blank spacer rows used as aisles. */
function seatedRows(rows) {
  return rows.filter((r) => !r.isSpacer && r.cells.some(Boolean));
}

/**
 * How much a seat at the far edge of a row loses relative to a centre seat.
 *
 * In a 39-wide IMAX row the outermost seat really is a bad seat. In a 9-wide
 * hall the outermost seat is barely off-centre, so applying the same penalty
 * would make every seat in a small hall look mediocre.
 */
function edgePenaltyFor(rowWidth) {
  const NARROW = 10;
  const WIDE = 30;
  const MIN_PENALTY = 0.25;
  const MAX_PENALTY = 0.6;
  if (rowWidth <= NARROW) return MIN_PENALTY;
  if (rowWidth >= WIDE) return MAX_PENALTY;
  const t = (rowWidth - NARROW) / (WIDE - NARROW);
  return MIN_PENALTY + t * (MAX_PENALTY - MIN_PENALTY);
}

/**
 * Desirability weight for a seat position.
 *
 * Depth is measured over seated rows by ordinal position, not by the raw data-r
 * attribute: halls contain spacer rows that consume a row index without holding
 * seats (e.g. G F E D · C B A), which would otherwise shift the ideal depth.
 *
 * Depth 0 = back row, 1 = front row (nearest the screen). Verified consistent
 * across sampled halls: data-r=0 is always the back.
 */
function makeZoneWeight(rowCount) {
  // Peak just behind the middle — clearly in the back half, but not against the
  // back wall. Widen the bump in shallow halls so the peak can't land in the gap
  // between two rows.
  const PEAK = 0.3;
  const spread = Math.max(0.22, 0.6 / Math.max(rowCount - 1, 1));

  return (depthIndex, colPos, rowWidth) => {
    const depth = depthIndex / Math.max(rowCount - 1, 1);
    const rowWeight = gaussianBump(depth, PEAK, spread);

    const centerCol = (rowWidth - 1) / 2;
    const horizDist = Math.abs(colPos - centerCol) / Math.max(centerCol, 1);
    const colWeight = 1 - Math.min(horizDist, 1) * edgePenaltyFor(rowWidth);

    return rowWeight * 0.65 + colWeight * 0.35;
  };
}

function gaussianBump(x, peak, spread) {
  const d = (x - peak) / spread;
  return Math.exp(-0.5 * d * d);
}

/**
 * Contiguous runs of bookable seats within a row.
 *
 * A gap (null), an occupied seat, or a seat outside the allowed ticket category
 * all break the run — we never suggest a block that spans an aisle, and never
 * suggest seats the chosen ticket type cannot actually buy.
 *
 * Returns runs of { cell, pos } so the caller keeps each seat's real column
 * position without an O(n) indexOf lookup per seat.
 */
function findBookableRuns(cells) {
  const runs = [];
  let current = [];

  cells.forEach((cell, pos) => {
    if (cell && cell.selectable) {
      current.push({ cell, pos });
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length) runs.push(current);

  return runs;
}

/**
 * The best score any N adjacent seats could achieve in this hall if it were
 * completely empty. Dividing by this turns a raw score into "how close is this
 * to the best seat in the house", which is comparable between a 55-seat hall
 * and a 456-seat IMAX — raw scores are not.
 */
function bestPossibleScore(rows, ticketCount) {
  const seated = seatedRows(rows);
  const zoneWeight = makeZoneWeight(seated.length);
  let best = 0;

  seated.forEach((row, depthIndex) => {
    const width = row.cells.length;
    // Ignore availability and gaps: this is the geometric ceiling, so scan the
    // widest contiguous stretch the row physically has.
    for (let start = 0; start + ticketCount <= width; start++) {
      let sum = 0;
      for (let i = 0; i < ticketCount; i++) {
        sum += zoneWeight(depthIndex, start + i, width);
      }
      best = Math.max(best, sum / ticketCount);
    }
  });

  return best;
}

/**
 * @param {object} seatMap  output of parseSeatMap() — { rows, ... }
 * @param {number} ticketCount how many adjacent seats are needed
 * @param {number} topN how many suggestions to return
 * @returns {Array} ranked candidates, best first
 */
export function findBestSeats(seatMap, ticketCount, topN = 5) {
  if (!Number.isInteger(ticketCount) || ticketCount < 1) {
    throw new Error('ticketCount must be a positive integer');
  }

  const rows = Array.isArray(seatMap) ? seatMap : seatMap.rows;
  const seated = seatedRows(rows);
  if (seated.length === 0) return [];

  const zoneWeight = makeZoneWeight(seated.length);
  const ceiling = bestPossibleScore(rows, ticketCount) || 1;
  const candidates = [];

  seated.forEach((row, depthIndex) => {
    const rowWidth = row.cells.length;

    for (const run of findBookableRuns(row.cells)) {
      if (run.length < ticketCount) continue;

      for (let start = 0; start + ticketCount <= run.length; start++) {
        const window = run.slice(start, start + ticketCount);

        let sum = 0;
        for (const { pos } of window) sum += zoneWeight(depthIndex, pos, rowWidth);
        const raw = sum / ticketCount;

        candidates.push({
          rowLetter: row.rowLetter,
          rowIndex: row.rowIndex,
          seats: window.map(({ cell }) => ({
            rowLetter: cell.rowLetter,
            seatNumber: cell.seatNumber,
            rowIndex: cell.rowIndex,
            colIndex: cell.colIndex,
          })),
          // Normalised: 1.0 means "the best seats this hall can offer".
          score: round3(Math.min(raw / ceiling, 1)),
          rawScore: round3(raw),
        });
      }
    }
  });

  candidates.sort((a, b) => b.score - a.score);

  // Windows overlap heavily (5-6-7 and 6-7-8 are both valid but redundant), so
  // keep the best and then only non-overlapping alternatives.
  const deduped = [];
  const usedSeats = new Set();

  for (const candidate of candidates) {
    const keys = candidate.seats.map((s) => `${s.rowLetter}-${s.seatNumber}`);
    if (keys.some((k) => usedSeats.has(k))) continue;

    deduped.push(candidate);
    keys.forEach((k) => usedSeats.add(k));
    if (deduped.length >= topN) break;
  }

  return deduped;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Top normalised score, for ranking showtimes against each other.
 *
 * Normalised deliberately: comparing raw scores across halls of different
 * shapes is meaningless, and would consistently rank a mediocre pair in a large
 * hall above an excellent pair in a small one.
 *
 * @returns {number|null} null when no block of that size is bookable at all
 */
export function bestScore(seatMap, ticketCount) {
  const results = findBestSeats(seatMap, ticketCount, 1);
  return results.length ? results[0].score : null;
}

/**
 * "H sırası, koltuk 9-10" — the answer stated in words, since the point of the
 * app is to tell you which seats to buy.
 */
export function describeSuggestion(suggestion) {
  if (!suggestion || !suggestion.seats.length) return null;
  const numbers = suggestion.seats.map((s) => s.seatNumber).sort((a, b) => a - b);
  const range =
    numbers.length === 1
      ? `koltuk ${numbers[0]}`
      : `koltuk ${numbers[0]}-${numbers[numbers.length - 1]}`;
  return `${suggestion.rowLetter} sırası, ${range}`;
}
