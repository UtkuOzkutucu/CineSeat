/**
 * Express app. Runs standalone (`npm start`) or is booted in-process by the
 * Electron main process.
 *
 * There is no background crawler any more — the catalogue is fetched live. The
 * only recurring work is refreshing followed showtimes, and only if you have
 * any.
 */

import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import apiRoutes from './api/routes.js';
import { follows as followStore } from './store.js';
import { getSeats } from './seats.js';
import { server as serverConfig, follows as followCfg } from './config.js';

const __dir = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
  app.use(express.static(join(__dir, '../public')));
  return app;
}

/**
 * Keep followed showtimes' seat counts current. Runs on the background lane so
 * it can never delay something you are waiting for, and does nothing at all
 * when the follow list is empty.
 */
function startFollowRefresher() {
  const tick = async () => {
    const items = followStore.list().filter((f) => !f.expired);
    for (const f of items) {
      try {
        const seats = await getSeats({
          cinemaCode: f.cinemaCode,
          sessionId: f.sessionId,
          ticketCount: f.ticketCount,
          force: true,
        });
        followStore.updateStats(f.id, {
          available: seats.available,
          total: seats.totalSeats,
          bestScore: seats.bestScore,
          bestLabel: seats.bestLabel,
        });
      } catch (err) {
        followStore.updateStats(f.id, { error: err.message });
      }
    }
  };

  const timer = setInterval(tick, followCfg.refreshIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port] 0 picks a free port (Electron uses this)
 * @param {boolean} [opts.followRefresh]
 * @returns {Promise<{port:number, close:() => Promise<void>}>}
 */
export function startServer({ port = serverConfig.port, followRefresh = true } = {}) {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, () => {
      const stopRefresher = followRefresh ? startFollowRefresher() : () => {};
      resolve({
        port: httpServer.address().port,
        close: () =>
          new Promise((done) => {
            stopRefresher();
            // close() alone only stops new connections and then waits for the
            // open ones. A live /api/scan SSE stream never ends by itself, so
            // without this the promise hangs and the process never exits.
            httpServer.closeAllConnections?.();
            httpServer.close(done);
          }),
      });
    });
    httpServer.on('error', reject);
  });
}

// Only auto-start when run directly, not when imported by Electron.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const { port } = await startServer();
  console.log(`\n  CineSeat → http://localhost:${port}\n`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => process.exit(0));
  }
}
