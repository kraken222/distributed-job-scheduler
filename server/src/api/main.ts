import { config } from '../config.js';
import { logger } from '../logger.js';
import { openDatabase } from '../db/connection.js';
import { materializeDueSchedules } from '../core/scheduler.js';
import { reap } from '../core/reaper.js';
import { createApp } from './app.js';

/**
 * API process. Besides serving REST it runs the two coordinator loops:
 *  - cron scheduler: turns due recurring schedules into job rows;
 *  - reaper: recovers work from crashed workers (expired leases).
 * Both are safe to run in several processes at once (CAS / idempotent),
 * so scaling the API horizontally does not double-fire schedules.
 */
const db = openDatabase();
const app = createApp(db);

const schedulerTimer = setInterval(() => {
  try {
    materializeDueSchedules(db);
  } catch (err) {
    logger.error({ err }, 'scheduler tick failed');
  }
}, config.schedulerTickMs);

const reaperTimer = setInterval(() => {
  try {
    reap(db, { workerStaleMs: config.workerStaleMs });
  } catch (err) {
    logger.error({ err }, 'reaper tick failed');
  }
}, config.reaperTickMs);

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, db: config.databaseFile }, 'API listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'API shutting down');
  clearInterval(schedulerTimer);
  clearInterval(reaperTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Fallback if keep-alive sockets prevent a clean close.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
