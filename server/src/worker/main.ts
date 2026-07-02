import { config } from '../config.js';
import { logger } from '../logger.js';
import { openDatabase } from '../db/connection.js';
import { Worker } from './worker.js';

const db = openDatabase();
const worker = new Worker(db, {
  name: process.env.WORKER_NAME ?? `worker-${process.pid}`,
  concurrency: config.workerConcurrency,
  pollMs: config.workerPollMs,
  heartbeatMs: config.heartbeatMs,
  leaseMs: config.leaseMs,
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker shutting down gracefully');
  await worker.stop();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

worker.start().catch((err) => {
  logger.error({ err }, 'worker crashed');
  process.exit(1);
});
