/**
 * Rate-limited HTTP transport for paribucineverse.com.
 *
 * Two queues, picked per call:
 *   - interactive: catalogue panels and seat scans, where a person is waiting
 *   - background:  the follow-list refresh, which nobody is watching
 *
 * Both are process-wide, so a background refresh can never get in front of a
 * click. Uses Node's global fetch (18+).
 */

import PQueue from 'p-queue';
import { BASE_URL, http, backoff } from '../config.js';

const BASE_HEADERS = {
  'User-Agent': http.userAgent,
  'Accept-Language': http.acceptLanguage,
  'Accept-Encoding': 'gzip, deflate, br',
};

const AJAX_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  'X-TS-AJAX-Request': 'true',
  Origin: BASE_URL,
};

const queues = {
  interactive: new PQueue({
    concurrency: http.lanes.interactive.concurrency,
    interval: http.lanes.interactive.minDelayMs,
    intervalCap: http.lanes.interactive.concurrency,
  }),
  background: new PQueue({
    concurrency: http.lanes.background.concurrency,
    interval: http.lanes.background.minDelayMs,
    intervalCap: 1,
  }),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Adaptive backoff ─────────────────────────────────────────────────────────

const throttle = {
  demotedUntil: 0,
  reason: null,
  consecutiveFailures: 0,
  demotions: 0,
};

function isDemoted() {
  if (throttle.demotedUntil && Date.now() > throttle.demotedUntil) {
    throttle.demotedUntil = 0;
    throttle.reason = null;
    queues.interactive.concurrency = http.lanes.interactive.concurrency;
  }
  return throttle.demotedUntil > 0;
}

/**
 * Slow the interactive lane down to background pacing for a while. Called when
 * the site pushes back — continuing at full speed from there is how you get
 * blocked.
 */
function demote(reason) {
  throttle.demotedUntil = Date.now() + backoff.demoteForMs;
  throttle.reason = reason;
  throttle.demotions++;
  queues.interactive.concurrency = http.lanes.background.concurrency;
  console.warn(`[net] interactive lane slowed for ${backoff.demoteForMs / 60000} min — ${reason}`);
}

function noteFailure(reason, status) {
  if (status === 429 || status === 403) {
    demote(`HTTP ${status} from the site`);
    return;
  }
  throttle.consecutiveFailures++;
  if (throttle.consecutiveFailures >= backoff.consecutiveFailuresBeforeDemote) {
    demote(`${throttle.consecutiveFailures} istek üst üste başarısız oldu`);
  }
}

function noteSuccess() {
  throttle.consecutiveFailures = 0;
}

export function netStatus() {
  const demoted = isDemoted();
  return {
    demoted,
    reason: throttle.reason,
    resumesAt: demoted ? new Date(throttle.demotedUntil).toISOString() : null,
    demotions: throttle.demotions,
    consecutiveFailures: throttle.consecutiveFailures,
    queues: {
      interactive: { pending: queues.interactive.pending, queued: queues.interactive.size },
      background: { pending: queues.background.pending, queued: queues.background.size },
    },
  };
}

// ─── Request ──────────────────────────────────────────────────────────────────

class TransientError extends Error {}

async function once(url, { method, headers, body, expect }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), http.timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...BASE_HEADERS, ...headers },
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new TransientError(`${method} ${url} → ${http.timeoutMs}ms içinde yanıt vermedi`);
    }
    throw new TransientError(`${method} ${url} → ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 || res.status === 403) {
    noteFailure('rate limited', res.status);
    throw new TransientError(`${method} ${url} → HTTP ${res.status}`);
  }
  if (res.status >= 500) throw new TransientError(`${method} ${url} → HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}`); // our fault; don't retry

  const text = await res.text();

  // The empty-body guard is only for endpoints where an empty 200 is always a
  // failure — chiefly BookingSeat, which answers "\r\n\r\n\r\n\r\n" when no
  // ticket was registered. Catalogue views legitimately return nothing when a
  // film simply has no showtimes that day, so they opt out with
  // 'html-optional'.
  if (expect === 'html' && text.trim().length < http.minHtmlBytes) {
    throw new TransientError(
      `${method} ${url} → HTTP 200 ama gövde yalnızca ${text.trim().length} bayt ` +
        `(en az ${http.minHtmlBytes} bekleniyordu) — başarı değil, hata sayılıyor`,
    );
  }

  return text;
}

/**
 * @param {string} url absolute or site-relative
 * @param {object} [opts]
 * @param {'interactive'|'background'} [opts.lane]
 * @param {'html'|'json'|'any'} [opts.expect] enables the empty-body guard for html
 */
export function request(url, opts = {}) {
  const {
    lane = 'interactive',
    method = 'GET',
    headers = {},
    body = null,
    expect = 'html',
  } = opts;

  const full = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  // While demoted, interactive work is queued behind the slow lane on purpose.
  const queue = isDemoted() && lane === 'interactive' ? queues.background : queues[lane];

  return queue.add(async () => {
    let lastErr;
    for (let attempt = 1; attempt <= http.maxAttempts; attempt++) {
      try {
        const text = await once(full, { method, headers, body, expect });
        noteSuccess();
        return text;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof TransientError)) throw err;
        if (attempt < http.maxAttempts) await sleep(http.retryBaseMs * 2 ** (attempt - 1));
      }
    }
    noteFailure(lastErr?.message);
    throw lastErr;
  });
}

/** GET returning HTML. */
export function get(path, opts = {}) {
  return request(path, { ...opts, method: 'GET' });
}

/**
 * POST an ASP.NET MVC model as form-urlencoded — the shape the site's own
 * jQuery `$.ajax({data: model})` produces.
 */
export function postModel(path, model, opts = {}) {
  return request(path, {
    ...opts,
    method: 'POST',
    headers: { ...AJAX_HEADERS, ...(opts.headers ?? {}) },
    body: encodeFormModel(model).join('&'),
  });
}

/** POST and parse JSON. */
export async function postJson(path, model, opts = {}) {
  const text = await postModel(path, model, { ...opts, expect: 'json' });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} JSON döndürmedi: ${text.slice(0, 200)}`);
  }
}

/**
 * ASP.NET model binding format:
 *   { TicketTypes: [{ TicketTypeCode: '0146', Qty: 2 }] }
 *   → TicketTypes[0][TicketTypeCode]=0146&TicketTypes[0][Qty]=2
 *
 * Empty arrays are omitted, which matches what the site sends.
 */
export function encodeFormModel(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      encodeFormModel(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return out;
}
