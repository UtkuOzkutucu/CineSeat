/**
 * A thin layer over the live catalogue.
 *
 * Every catalogue route is a single upstream call and returns in well under a
 * second, so there is nothing to pre-warm and nothing to go stale. Only /seats
 * and /scan do real work.
 */

import express from 'express';
import * as cv from '../net/cineverse.js';
import { netStatus } from '../net/client.js';
import { getSeats, scanShowtimes } from '../seats.js';
import { favourites, follows, settings, stats as storeStats } from '../store.js';
import { search } from '../config.js';

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ticketCountFrom(raw) {
  if (raw === undefined || raw === '') return settings.get('ticketCount') ?? search.defaultTicketCount;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > search.maxTicketCount) {
    throw new HttpError(400, `Bilet sayısı 1 ile ${search.maxTicketCount} arasında olmalı.`);
  }
  return n;
}

function requireParam(value, name) {
  if (!value) throw new HttpError(400, `${name} gerekli.`);
  return value;
}

function isoDate(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw ?? '')) {
    throw new HttpError(400, 'Tarih YYYY-MM-DD biçiminde olmalı.');
  }
  return raw;
}

// ─── Catalogue ────────────────────────────────────────────────────────────────

/**
 * Cinemas, optionally only those showing a film, optionally distance-sorted.
 * Favourite flags are merged in from local storage.
 */
router.get(
  '/cinemas',
  wrap(async (req, res) => {
    const { filmId, lat, lng } = req.query;
    const list = await cv.getCinemas({
      filmId: filmId || null,
      latitude: lat ? Number(lat) : 0,
      longitude: lng ? Number(lng) : 0,
    });
    const favs = new Set(favourites.list());
    res.json(list.map((c) => ({ ...c, isFavourite: favs.has(c.id) })));
  }),
);

router.get(
  '/films',
  wrap(async (req, res) => {
    res.json(await cv.getFilms({ cinemaId: req.query.cinemaId || null }));
  }),
);

router.get(
  '/dates',
  wrap(async (req, res) => {
    const filmId = requireParam(req.query.filmId, 'filmId');
    const cinemaId = requireParam(req.query.cinemaId, 'cinemaId');
    res.json(await cv.getDates({ filmId, cinemaId }));
  }),
);

/** Showtimes, grouped by hall technology and format exactly as the site groups them. */
router.get(
  '/sessions',
  wrap(async (req, res) => {
    const filmId = requireParam(req.query.filmId, 'filmId');
    const cinemaId = requireParam(req.query.cinemaId, 'cinemaId');
    const date = isoDate(req.query.date);
    res.json(await cv.getSessions({ filmId, cinemaId, date }));
  }),
);

router.get(
  '/technologies',
  wrap(async (req, res) => {
    res.json(await cv.getTechnologies());
  }),
);

// ─── Seats ────────────────────────────────────────────────────────────────────

router.get(
  '/seats/:cinemaCode/:sessionId',
  wrap(async (req, res) => {
    const { cinemaCode, sessionId } = req.params;
    const ticketCount = ticketCountFrom(req.query.ticketCount);
    try {
      res.json(
        await getSeats({
          cinemaCode,
          sessionId,
          ticketCount,
          ticketTypeCode: req.query.ticketTypeCode || null,
          force: req.query.refresh === '1',
        }),
      );
    } catch (err) {
      // Upstream failure, not an empty hall.
      throw new HttpError(502, err.message);
    }
  }),
);

/**
 * Scan every showtime of one film at one cinema on one date, streaming results
 * over SSE so the UI can show progress and cancel.
 */
router.get(
  '/scan',
  wrap(async (req, res) => {
    const filmId = requireParam(req.query.filmId, 'filmId');
    const cinemaId = requireParam(req.query.cinemaId, 'cinemaId');
    const date = isoDate(req.query.date);
    const ticketCount = ticketCountFrom(req.query.ticketCount);

    const { showtimes } = await cv.getSessions({ filmId, cinemaId, date });
    if (showtimes.length === 0) throw new HttpError(404, 'Bu tarihte seans yok.');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const signal = { aborted: false };
    req.on('close', () => {
      signal.aborted = true;
    });

    send('start', { total: showtimes.length });
    try {
      const results = await scanShowtimes(
        showtimes,
        ticketCount,
        (done, total, latest) => send('progress', { done, total, latest }),
        signal,
      );
      if (!signal.aborted) send('done', { results });
    } catch (err) {
      send('error', { message: err.message });
    } finally {
      res.end();
    }
  }),
);

// ─── Favourites, follows, settings ────────────────────────────────────────────

router.get('/favourites', (req, res) => res.json(favourites.list()));

router.post('/favourites/:cinemaId', (req, res) => {
  const on = favourites.toggle(req.params.cinemaId, req.body?.isFavourite);
  res.json({ ok: true, cinemaId: req.params.cinemaId, isFavourite: on });
});

router.get('/follows', (req, res) => res.json(follows.list()));

router.post('/follows', (req, res) => {
  const b = req.body ?? {};
  if (!b.cinemaCode || !b.sessionId) {
    throw new HttpError(400, 'cinemaCode ve sessionId gerekli.');
  }
  // Everything needed to reopen the seat map later — there is no local
  // catalogue to look any of it up in.
  const added = follows.add({
    cinemaCode: b.cinemaCode,
    sessionId: b.sessionId,
    ticketCount: ticketCountFrom(b.ticketCount),
    filmId: b.filmId ?? null,
    cinemaId: b.cinemaId ?? null,
    filmTitle: b.filmTitle ?? null,
    cinemaName: b.cinemaName ?? null,
    date: b.date ?? null,
    time: b.time ?? null,
    startsAt: b.startsAt ?? null,
    isNextDay: Boolean(b.isNextDay),
    label: b.label ?? null,
    technologies: b.technologies ?? [],
  });
  res.json({ ok: true, added });
});

router.delete('/follows/:id', (req, res) => {
  res.json({ ok: true, removed: follows.remove(req.params.id) });
});

router.post('/follows/clear-expired', (req, res) => {
  res.json({ ok: true, removed: follows.clearExpired() });
});

router.get('/settings', (req, res) => res.json(settings.all()));

router.post('/settings', (req, res) => {
  const patch = {};
  if (req.body?.ticketCount !== undefined) patch.ticketCount = ticketCountFrom(req.body.ticketCount);
  if (req.body?.autoScan !== undefined) patch.autoScan = Boolean(req.body.autoScan);
  if (req.body?.city !== undefined) patch.city = req.body.city || null;
  res.json(settings.set(patch));
});

// ─── Status ───────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    net: netStatus(),
    store: storeStats(),
    settings: settings.all(),
    follows: follows.list().length,
  });
});

// ─── Errors ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- Express detects error middleware by arity
router.use((err, req, res, next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl} → ${err.message}`);
  res.status(status).json({ error: err.message });
});

export default router;
