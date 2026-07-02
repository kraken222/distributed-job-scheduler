import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import type { DB } from '../src/db/connection.js';
import { newId } from '../src/core/ids.js';
import { completeJob, failJob, startJob } from '../src/core/claims.js';

/** Fresh in-memory database with the full schema + system retry policies. */
export function testDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export interface Fixture {
  orgId: string;
  userId: string;
  projectId: string;
  queueId: string;
}

export function seedFixture(db: DB, queueOpts: { priority?: number; concurrency?: number; retryPolicyId?: string | null } = {}): Fixture {
  const now = Date.now();
  const orgId = newId.org();
  const userId = newId.user();
  const projectId = newId.project();
  const queueId = newId.queue();
  db.prepare(`INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)`).run(orgId, 'TestOrg', now);
  db.prepare(
    `INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'x', 'admin', ?)`,
  ).run(userId, orgId, `u-${userId}@test.dev`, 'Tester', now);
  db.prepare(`INSERT INTO projects (id, org_id, name, created_at) VALUES (?, ?, 'proj', ?)`).run(projectId, orgId, now);
  db.prepare(
    `INSERT INTO queues (id, project_id, name, priority, concurrency_limit, retry_policy_id, created_at, updated_at)
     VALUES (?, ?, 'default', ?, ?, ?, ?, ?)`,
  ).run(queueId, projectId, queueOpts.priority ?? 0, queueOpts.concurrency ?? 10, queueOpts.retryPolicyId ?? null, now, now);
  return { orgId, userId, projectId, queueId };
}

export function addQueue(
  db: DB,
  projectId: string,
  name: string,
  opts: {
    priority?: number;
    concurrency?: number;
    paused?: boolean;
    rateLimitMax?: number;
    rateLimitWindowMs?: number;
    shardCount?: number;
  } = {},
): string {
  const now = Date.now();
  const id = newId.queue();
  db.prepare(
    `INSERT INTO queues (id, project_id, name, priority, concurrency_limit, is_paused,
                         rate_limit_max, rate_limit_window_ms, shard_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, projectId, name, opts.priority ?? 0, opts.concurrency ?? 10, opts.paused ? 1 : 0,
    opts.rateLimitMax ?? null, opts.rateLimitWindowMs ?? null, opts.shardCount ?? 1, now, now,
  );
  return id;
}

/** Drive a claimed-or-claimable job to 'completed' through the real state machine. */
export function runToCompletion(db: DB, workerId: string, jobId: string, now: number = Date.now()): void {
  const started = startJob(db, jobId, workerId, now);
  if (!started) throw new Error(`could not start job ${jobId}`);
  completeJob(db, { jobId, executionId: started.executionId, workerId, now });
}

/** Drive a claimed job to a failed attempt (retry or dead per its policy). */
export function runToFailure(db: DB, workerId: string, jobId: string, error = 'boom', now: number = Date.now()) {
  const started = startJob(db, jobId, workerId, now);
  if (!started) throw new Error(`could not start job ${jobId}`);
  return failJob(db, { jobId, executionId: started.executionId, workerId, error, now });
}

export function addWorker(db: DB, name = 'w1'): string {
  const now = Date.now();
  const id = newId.worker();
  db.prepare(
    `INSERT INTO workers (id, name, hostname, pid, concurrency, status, started_at, last_heartbeat_at)
     VALUES (?, ?, 'test', 1, 5, 'online', ?, ?)`,
  ).run(id, name, now, now);
  return id;
}
