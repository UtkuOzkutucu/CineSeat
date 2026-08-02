/**
 * The seat grid returned by POST /Ticketing/BookingSeat.
 *
 *   <table id="seatContainer" data-allowed-cc="0000000001" data-allocated-seat-count="2">
 *     <tbody>
 *       <tr>
 *         <th class="seat-letter"><div>D</div></th>
 *         <td class="occupied"><div class="seat" data-cc data-r data-c data-number>1</div></td>
 *         <td class="cc-one"><div class="seat" …>3</div></td>
 *         <td class="no-seat"><div>&nbsp;</div></td>        ← aisle gap
 *
 * These selectors were correct in the very first build — the reason every seat
 * map came back empty was a missing step in the booking flow
 * (AddTicketWithConcession), not the parsing.
 *
 * Row order is back-to-front: data-r=0 is the back row, the last row is nearest
 * the screen (verified as G→A, O→A and K→A across three differently sized halls).
 */

import * as cheerio from 'cheerio';

export function parseSeatMap(html) {
  const $ = cheerio.load(html);
  const $table = $('#seatContainer');

  if ($table.length === 0) {
    throw new Error(
      'BookingSeat yanıtında #seatContainer yok. Genellikle bu oturum için bilet ' +
        'adedi kaydedilmediği (AddTicketWithConcession) anlamına gelir.',
    );
  }

  const allowedCc = ($table.attr('data-allowed-cc') || '').trim() || null;
  const allocatedSeatCount = parseInt($table.attr('data-allocated-seat-count') || '', 10) || null;

  const rows = [];
  let seatCount = 0;

  $table.find('tr').each((_, tr) => {
    const $tr = $(tr);
    const rowLetter = $tr.find('th.seat-letter div').first().text().trim();
    const cells = [];
    let rowSeats = 0;
    let rowIndex = null;

    $tr.find('td').each((__, td) => {
      const $td = $(td);
      const cls = $td.attr('class') || '';
      const $seat = $td.find('div.seat');

      if (cls.includes('no-seat') || $seat.length === 0) {
        cells.push(null); // aisle / gap — a hard break for adjacency scanning
        return;
      }

      const categoryCode = ($seat.attr('data-cc') || '').trim() || null;
      const r = parseInt($seat.attr('data-r'), 10);
      if (rowIndex === null && Number.isFinite(r)) rowIndex = r;

      const state = cls.includes('occupied')
        ? 'occupied'
        : cls.includes('handicapped')
          ? 'handicapped'
          : 'available';

      cells.push({
        rowLetter,
        rowIndex: r,
        colIndex: parseInt($seat.attr('data-c'), 10),
        seatNumber: parseInt($seat.attr('data-number'), 10),
        categoryCode,
        state,
        // A seat can be free yet unbookable with the chosen ticket type: the
        // table's data-allowed-cc gates which category may be selected.
        selectable: state === 'available' && (!allowedCc || categoryCode === allowedCc),
      });
      rowSeats++;
    });

    // Halls contain spacer rows — a <tr> with no letter and no seats, used as a
    // horizontal aisle (e.g. G F E D · C B A). data-r skips them, so they must
    // not count toward depth.
    rows.push({ rowLetter: rowLetter || null, rowIndex, isSpacer: rowSeats === 0, cells });
    seatCount += rowSeats;
  });

  if (seatCount === 0) {
    throw new Error(
      '#seatContainer bulundu ama içinde koltuk yok. Bunu boş salon olarak ' +
        'raporlamak yerine hata sayıyoruz.',
    );
  }

  const seatedRows = rows.filter((r) => !r.isSpacer);

  return {
    rows,
    allowedCc,
    allocatedSeatCount,
    rowCount: seatedRows.length,
    maxRowWidth: Math.max(...seatedRows.map((r) => r.cells.filter(Boolean).length)),
    totalSeats: seatCount,
    available: countState(rows, 'available'),
    occupied: countState(rows, 'occupied'),
    handicapped: countState(rows, 'handicapped'),
  };
}

function countState(rows, state) {
  let n = 0;
  for (const row of rows) {
    for (const cell of row.cells) if (cell && cell.state === state) n++;
  }
  return n;
}
