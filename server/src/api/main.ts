import { config } from '../config.js';
import { logger } from '../logger.js';
import { openDatabase } from '../db/connection.js';
import { materializeDueSchedules } from '../core/scheduler.js';
import { reap } from '../core/reaper.js';
import { summarizeDeadLetters } from '../core/failureSummary.js';
import { createApp } from './app.js';
import { attachWebSockets } from './ws.js';

/**
 * API process. Besides serving REST it runs the coordinator loops:
 *  - cron scheduler: turns due recurring schedules into job rows;
 *  - reaper: recovers work from crashed workers (expired leases);
 *  - summarizer: writes AI/heuristic failure summaries onto new DLQ entries.
 * All are safe to run in several processes at once (CAS / idempotent),
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

const summaryTimer = setInterval(() => {
  summarizeDeadLetters(db, { apiKey: config.anthropicApiKey, model: config.anthropicModel }).catch((err) =>
    logger.error({ err }, 'failure summarizer tick failed'),
  );
}, config.summaryTickMs);

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, db: config.databaseFile, aiSummaries: config.anthropicApiKey !== '' },
    'API listening',
  );
});
const sockets = attachWebSockets(server, db);

function shutdown(signal: string) {
  logger.info({ signal }, 'API shutting down');
  clearInterval(schedulerTimer);
  clearInterval(reaperTimer);
  clearInterval(summaryTimer);
  sockets.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Fallback if keep-alive sockets prevent a clean close.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
