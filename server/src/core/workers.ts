import os from 'node:os';
import type { DB } from '../db/connection.js';
import type { WorkerRow } from '../types.js';
import { newId } from './ids.js';
import { extendLeases } from './claims.js';

export function registerWorker(db: DB, args: { name: string; concurrency: number }, now: number = Date.now()): WorkerRow {
  const id = newId.worker();
  return db
    .prepare(
      `INSERT INTO workers (id, name, hostname, pid, concurrency, status, started_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?, 'online', ?, ?) RETURNING *`,
    )
    .get(id, args.name, os.hostname(), process.pid, args.concurrency, now, now) as WorkerRow;
}

/** Records liveness, keeps a bounded heartbeat history, and renews job leases in one shot. */
export function heartbeat(
  db: DB,
  args: { workerId: string; activeJobs: number; leaseMs: number },
  now: number = Date.now(),
): void {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE workers SET last_heartbeat_at = ? WHERE id = ?`).run(now, args.workerId);
    db.prepare(`INSERT INTO worker_heartbeats (worker_id, at, active_jobs) VALUES (?, ?, ?)`).run(
      args.workerId,
      now,
      args.activeJobs,
    );
    // Keep the table bounded: retain the most recent 100 heartbeats per worker.
    db.prepare(
      `DELETE FROM worker_heartbeats
       WHERE worker_id = ? AND id NOT IN (
         SELECT id FROM worker_heartbeats WHERE worker_id = ? ORDER BY id DESC LIMIT 100)`,
    ).run(args.workerId, args.workerId);
    extendLeases(db, args.workerId, args.leaseMs, now);
  });
  tx.immediate();
}

export function setWorkerStatus(db: DB, workerId: string, status: 'draining' | 'offline', now: number = Date.now()): void {
  db.prepare(`UPDATE workers SET status = ?, stopped_at = CASE WHEN ? = 'offline' THEN ? ELSE stopped_at END WHERE id = ?`).run(
    status,
    status,
    now,
    workerId,
  );
}
