/**
 * Smart Seat Detection
 * ────────────────────
 * Input: the grid from parseSeatMap() — rows of cells, where a cell is either
 * null (aisle/gap — a hard break) or a seat { rowIndex, colIndex, state,
 * selectable }.
 *
 *   1. Score every position by its distance from the hall's ideal spot.
 *   2. Slide a window of N seats across every run of adjacent free seats.
 *   3. Normalise against the best the hall could offer.
 *   4. Return the top non-overlapping candidates, best first.
 *
 * A seat's score is its depth quality multiplied by its horizontal quality.
 * They are multiplied rather than added so each axis owns its own range: the
 * front row can be worth nothing at all while horizontal position still orders
 * seats independently within every other row. Sharing one additive budget made
 * that impossible — pushing the front row down to nothing left nothing over for
 * horizontal, and a dead-centre front-row seat still scored 60%.
 */

/** Seats physically in the hall, ignoring the blank spacer rows used as aisles. */
function seatedRows(rows) {
  return rows.filter((r) => !r.isSpacer && r.cells.some(Boolean));
}

/**
 * Fraction of the way back from the screen: 0 = front row, 1 = back row.
 * Three quarters back is the sweet spot — in a 15-row hall that is rows K/L.
 */
const IDEAL_DEPTH = 0.75;

/** Falloff toward the screen. Puts row H at 74% and row G at 64%. */
const FRONT_EXP = 1.2;

/** Falloff toward the back wall: gentle just behind the ideal, steeper at the wall. */
const BACK_EXP = 2;

/**
 * How much the back row loses, by hall size.
 *
 * The back row of a 7-row hall is barely far from the screen; the back row of a
 * 15-row hall genuinely is. Same reasoning as FULL_OFFSET_SEATS below — what
 * matters is absolute distance, not the fraction of the hall.
 */
const SMALL_ROWS = 7;
const BIG_ROWS = 15;
const BACK_DROP_SMALL = 0.2; // → back row ≈ 80%
const BACK_DROP_BIG = 0.4; // → back row = 60%

/**
 * How far off-centre, in seats, before the viewing angle is as bad as it gets.
 *
 * Deliberately an absolute count rather than a fraction of the row. Dividing by
 * each hall's own half-width would make the outermost seat of a 9-wide hall
 * score exactly as badly as the outermost seat of a 39-wide IMAX — but four
 * seats from centre is nearly central, and nineteen is not.
 */
const FULL_OFFSET_SEATS = 12;

/**
 * How severe the sideways penalty is, interpolated by hall width.
 *
 * The same distance means different things in different rooms: four seats
 * off-centre is nearly central in an 11-wide hall and genuinely off-axis in a
 * 25-wide one. A single absolute curve has to pick one of those answers and be
 * wrong about the other — so the reference distance stays fixed while the
 * curve's severity scales.
 *
 * `drop` is what a seat at the full offset loses. A lower `exp` makes the
 * penalty bite at moderate offsets rather than only against the wall, which is
 * what wide halls need: their mid-range seats are already well off-axis.
 */
const NARROW_COLS = 12;
const WIDE_COLS = 25;
const DROP_NARROW = 0.55;
const DROP_WIDE = 0.85;
const EXP_NARROW = 2.0;
const EXP_WIDE = 1.25;

function backDropFor(rowCount) {
  const t = clamp((rowCount - SMALL_ROWS) / (BIG_ROWS - SMALL_ROWS), 0, 1);
  return BACK_DROP_SMALL + t * (BACK_DROP_BIG - BACK_DROP_SMALL);
}

/**
 * Depth quality, 0..1, peaking at IDEAL_DEPTH.
 *
 * The front branch has no drop coefficient, so at p = 0 it evaluates to exactly
 * zero: the entire front row is worth nothing, which is what makes the front
 * corner read 0% rather than merely small.
 */
function depthScore(p, rowCount) {
  if (p <= IDEAL_DEPTH) {
    return 1 - Math.pow((IDEAL_DEPTH - p) / IDEAL_DEPTH, FRONT_EXP);
  }
  const past = (p - IDEAL_DEPTH) / (1 - IDEAL_DEPTH);
  return 1 - backDropFor(rowCount) * Math.pow(past, BACK_EXP);
}

/** Horizontal quality, 0..1, peaking dead centre. */
function horizScore(offset, colCount) {
  const wide = clamp((colCount - NARROW_COLS) / (WIDE_COLS - NARROW_COLS), 0, 1);
  const drop = DROP_NARROW + wide * (DROP_WIDE - DROP_NARROW);
  const exp = EXP_NARROW + wide * (EXP_WIDE - EXP_NARROW);
  const d = Math.min(Math.abs(offset) / FULL_OFFSET_SEATS, 1);
  return 1 - drop * Math.pow(d, exp);
}

/**
 * Desirability of a seat position; higher is better.
 *
 * Depth is measured over seated rows by ordinal position, not by the raw data-r
 * attribute: halls contain spacer rows that consume a row index without holding
 * seats (e.g. G F E D · C B A), which would otherwise shift the ideal depth.
 *
 * `colPos` is the seat's index in the row array, which is its true position in
 * the hall — not its printed seat number. Rows are often indented: in the
 * 13x25 fixture, row I holds seats numbered 1..18 in grid positions 5..22, so
 * "koltuk 7" there is very nearly centre. Centring on the printed number would
 * put every indented row off to one side.
 *
 * @param {number} rowCount seated rows in the hall
 * @param {number} colCount width of the widest seated row
 */
function makeSeatWeight(rowCount, colCount) {
  const xCenter = (colCount - 1) / 2;
  const depthSpan = Math.max(rowCount - 1, 1);

  return (yFromScreen, colPos) =>
    depthScore(yFromScreen / depthSpan, rowCount) * horizScore(colPos - xCenter, colCount);
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

/** Rows arrive back-first, so this flips an index into distance from the screen. */
function depthFromScreen(index, rowCount) {
  return rowCount - 1 - index;
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
  const colCount = Math.max(...seated.map((r) => r.cells.length));
  const seatWeight = makeSeatWeight(seated.length, colCount);
  let best = 0;

  seated.forEach((row, index) => {
    const depth = depthFromScreen(index, seated.length);
    const width = row.cells.length;
    // Ignore availability and gaps: this is the geometric ceiling, so scan the
    // widest contiguous stretch the row physically has.
    for (let start = 0; start + ticketCount <= width; start++) {
      let sum = 0;
      for (let i = 0; i < ticketCount; i++) {
        sum += seatWeight(depth, start + i);
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

  const colCount = Math.max(...seated.map((r) => r.cells.length));
  const seatWeight = makeSeatWeight(seated.length, colCount);
  const ceiling = bestPossibleScore(rows, ticketCount) || 1;
  const candidates = [];

  seated.forEach((row, index) => {
    const depth = depthFromScreen(index, seated.length);

    for (const run of findBookableRuns(row.cells)) {
      if (run.length < ticketCount) continue;

      for (let start = 0; start + ticketCount <= run.length; start++) {
        const window = run.slice(start, start + ticketCount);

        let sum = 0;
        for (const { pos } of window) sum += seatWeight(depth, pos);
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
