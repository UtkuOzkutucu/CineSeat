/**
 * The ticket-step page: the session token and this session's ticket types.
 */

import * as cheerio from 'cheerio';

/**
 * A showtime that exists but cannot be booked — typically late-night sessions
 * the site lists with no purchasable ticket type. This is a normal state, not a
 * breakage, so the UI shows it differently from a scrape failure.
 */
export class SessionUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.unavailable = true;
  }
}

/**
 * The site's own explanation when a showtime has nothing on sale, e.g.
 * "Bu seansa uygun bilet tipi bulunamadı, dilerseniz farklı bir seans seçimi
 * yapabilirsiniz." Returns null when the page looks normal.
 */
function unavailableReason($) {
  const text = $('.empty-data-content').first().text().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.replace(/\s*Seans Seçimine Dön\s*$/, '').trim();
}

/**
 * The UserSessionId. Freshly generated server-side on every page load, so it is
 * never reused across requests.
 */
export function parseUserSessionId(html) {
  const $ = cheerio.load(html);
  const uid =
    $('#btnTicketContinue').attr('data-usersessionid') ||
    $('[data-usersessionid]').first().attr('data-usersessionid');

  if (!uid) {
    const reason = unavailableReason($);
    if (reason) throw new SessionUnavailableError(reason);
    throw new Error(
      'Bilet adımı sayfasında UserSessionId bulunamadı — ' +
        '#btnTicketContinue[data-usersessionid] bekleniyordu.',
    );
  }
  return uid;
}

/**
 * Ticket types with prices.
 *
 *   <div class="ticket-flow-2-option-card" data-tc="0146" data-cc="0000000001"
 *        data-unit-price="32000">HALK GÜNÜ 320 TL</div>
 *
 * All of this is per-cinema and per-session and must never be hardcoded:
 * sampling six provinces found codes 0146/0231/0247/0002/1250/1058, prices from
 * 260 to 795 TL, and the *same* code 0002 priced 355 TL in Kocaeli but 400 TL in
 * Ankara. Gold Class halls use category 0000000010/0000000012, not 0000000001.
 *
 * @returns {{code, category_cc, label, price_minor, price}[]} cheapest first
 */
export function parseTicketTypes(html) {
  const $ = cheerio.load(html);
  const types = [];

  $('.ticket-flow-2-option-card').each((_, el) => {
    const $el = $(el);
    const code = ($el.attr('data-tc') || '').trim();
    if (!code) return;

    const priceMinor = parseInt($el.attr('data-unit-price') || '', 10);

    types.push({
      code,
      category_cc: ($el.attr('data-cc') || '').trim() || null,
      label: $el.text().replace(/\s+/g, ' ').trim() || null,
      price_minor: Number.isFinite(priceMinor) ? priceMinor : null,
      price: Number.isFinite(priceMinor) ? priceMinor / 100 : null,
    });
  });

  if (types.length === 0) {
    const reason = unavailableReason($);
    if (reason) throw new SessionUnavailableError(reason);
    throw new Error(
      'Bilet tipi bulunamadı — .ticket-flow-2-option-card bekleniyordu. ' +
        'Bilet tipi olmadan koltuk planı istenemez.',
    );
  }

  // Cheapest first, so callers can default sensibly without assuming a code.
  types.sort((a, b) => (a.price_minor ?? Infinity) - (b.price_minor ?? Infinity));
  return types;
}
