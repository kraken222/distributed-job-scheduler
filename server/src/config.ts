import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid integer for env ${name}: ${raw}`);
  return n;
}

export const config = {
  /** HTTP port for the REST API. */
  port: int('PORT', 4000),
  /** Path to the SQLite database file, shared by API and workers. */
  databaseFile: process.env.DATABASE_FILE ?? path.resolve(here, '../../data/scheduler.db'),
  /** Secret used to sign JWT access tokens. */
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  /** JWT lifetime in seconds. */
  jwtTtlSeconds: int('JWT_TTL_SECONDS', 60 * 60 * 12),

  // Worker tuning
  /** How many jobs a single worker process may run concurrently. */
  workerConcurrency: int('WORKER_CONCURRENCY', 5),
  /** Poll interval when the worker has free slots but found no work. */
  workerPollMs: int('WORKER_POLL_MS', 500),
  /** Heartbeat interval. */
  heartbeatMs: int('HEARTBEAT_MS', 3000),
  /** Lease granted on claim / extended by heartbeats. */
  leaseMs: int('LEASE_MS', 30000),

  // Coordinator (runs inside the API process)
  /** How often the cron scheduler materialises due recurring jobs. */
  schedulerTickMs: int('SCHEDULER_TICK_MS', 1000),
  /** How often the reaper looks for dead workers / expired leases. */
  reaperTickMs: int('REAPER_TICK_MS', 5000),
  /** A worker missing heartbeats for this long is considered lost. */
  workerStaleMs: int('WORKER_STALE_MS', 15000),

  logLevel: process.env.LOG_LEVEL ?? 'info',
} as const;
