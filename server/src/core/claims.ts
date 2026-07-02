import type { DB } from '../db/connection.js';
import type { ExecutionStatus, JobRow, RetryPolicyRow } from '../types.js';
import { DEFAULT_RETRY_POLICY_ID } from '../db/schema.js';
import { computeBackoffMs } from './retry.js';
import { newId } from './ids.js';

/**
 * Worker-side state transitions. Every function here runs inside an
 * IMMEDIATE transaction: SQLite serializes writers across processes, so a
 * job can never be claimed or transitioned by two workers at once — the
 * same guarantee `SELECT ... FOR UPDATE SKIP LOCKED` provides on Postgres.
 */

/**
 * Atomically claim up to `maxJobs` due jobs for a worker.
 *
 * Selection honours, in order:
 *  1. queue pause state (paused queues are skipped entirely),
 *  2. per-queue concurrency limits (jobs already claimed/running count
 *     against the queue's limit fleet-wide),
 *  3. queue priority, then job priority, then run_at/created_at (FIFO).
 */
export function claimJobs(db: DB, workerId: string, maxJobs: number, opts: { now?: number; leaseMs: number }): JobRow[] {
  const now = opts.now ?? Date.now();
  if (maxJobs <= 0) return [];

  const tx = db.transaction((): JobRow[] => {
    const candidates = db
      .prepare(
        `WITH capacity AS (
           SELECT q.id AS queue_id, q.priority AS queue_priority,
                  q.concurrency_limit - COUNT(active.id) AS free
           FROM queues q
           LEFT JOIN jobs active
             ON active.queue_id = q.id AND active.status IN ('claimed','running')
           WHERE q.is_paused = 0
           GROUP BY q.id
           HAVING free > 0
         ),
         candidates AS (
           SELECT j.id, c.queue_priority, c.free,
                  j.priority AS job_priority, j.run_at, j.created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY j.queue_id
                    ORDER BY j.priority DESC, j.run_at ASC, j.created_at ASC
                  ) AS rn
           FROM jobs j
           JOIN capacity c ON c.queue_id = j.queue_id
           WHERE j.status IN ('queued','scheduled','retrying') AND j.run_at <= @now
         )
         SELECT id FROM candidates
         WHERE rn <= free
         ORDER BY queue_priority DESC, job_priority DESC, run_at ASC, created_at ASC
         LIMIT @max`,
      )
      .all({ now, max: maxJobs }) as { id: string }[];

    if (candidates.length === 0) return [];

    const placeholders = candidates.map(() => '?').join(',');
    const claimed = db
      .prepare(
        `UPDATE jobs
         SET status = 'claimed', claimed_by = ?, lease_expires_at = ?, updated_at = ?
         WHERE id IN (${placeholders})
           AND status IN ('queued','scheduled','retrying')
         RETURNING *`,
      )
      .all(workerId, now + opts.leaseMs, now, ...candidates.map((c) => c.id)) as JobRow[];

    // RETURNING order is unspecified; restore the priority order of the SELECT.
    const rank = new Map(candidates.map((c, i) => [c.id, i]));
    return claimed.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  });

  return tx.immediate();
}

/** claimed → running; increments the attempt counter and opens an execution record. */
export function startJob(db: DB, jobId: string, workerId: string, now: number = Date.now()): { executionId: string; attempt: number } | null {
  const tx = db.transaction(() => {
    const job = db
      .prepare(
        `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'claimed' AND claimed_by = ?
         RETURNING attempts`,
      )
      .get(now, now, jobId, workerId) as { attempts: number } | undefined;
    if (!job) return null;

    const executionId = newId.execution();
    db.prepare(
      `INSERT INTO job_executions (id, job_id, worker_id, attempt, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    ).run(executionId, jobId, workerId, job.attempts, now);
    return { executionId, attempt: job.attempts };
  });
  return tx.immediate();
}

export function completeJob(
  db: DB,
  args: { jobId: string; executionId: string; workerId: string; result?: unknown; now?: number },
): boolean {
  const now = args.now ?? Date.now();
  const resultJson = args.result === undefined ? null : JSON.stringify(args.result);
  const tx = db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE jobs
         SET status = 'completed', completed_at = ?, result = ?, last_error = NULL,
             claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND claimed_by = ?`,
      )
      .run(now, resultJson, now, args.jobId, args.workerId).changes;
    if (changed === 0) return false;
    finishExecution(db, args.executionId, 'completed', now, { result: resultJson });
    return true;
  });
  return tx.immediate();
}

export interface FailureOutcome {
  outcome: 'retry' | 'dead';
  nextRunAt?: number;
  delayMs?: number;
}

/**
 * running → retrying (with backoff) or → dead (+ dead-letter entry) once the
 * resolved retry policy's max_attempts is exhausted. Policy resolution:
 * job override → queue policy → system default.
 */
export function failJob(
  db: DB,
  args: { jobId: string; executionId: string; workerId: string; error: string; timedOut?: boolean; now?: number },
): FailureOutcome | null {
  const now = args.now ?? Date.now();
  const tx = db.transaction((): FailureOutcome | null => {
    const job = db
      .prepare(
        `SELECT j.*, q.retry_policy_id AS queue_policy_id
         FROM jobs j JOIN queues q ON q.id = j.queue_id
         WHERE j.id = ? AND j.status = 'running' AND j.claimed_by = ?`,
      )
      .get(args.jobId, args.workerId) as (JobRow & { queue_policy_id: string | null }) | undefined;
    if (!job) return null;

    finishExecution(db, args.executionId, args.timedOut ? 'timed_out' : 'failed', now, { error: args.error });
    const policy = resolveRetryPolicy(db, job.retry_policy_id ?? job.queue_policy_id);
    return applyFailure(db, job, policy, args.error, now);
  });
  return tx.immediate();
}

/** Shared by failJob and the reaper: decide retry vs dead-letter for a failed attempt. */
export function applyFailure(db: DB, job: JobRow, policy: RetryPolicyRow, error: string, now: number): FailureOutcome {
  if (job.attempts < policy.max_attempts) {
    const delayMs = computeBackoffMs(
      { strategy: policy.strategy, baseDelayMs: policy.base_delay_ms, maxDelayMs: policy.max_delay_ms },
      job.attempts,
    );
    const nextRunAt = now + delayMs;
    db.prepare(
      `UPDATE jobs
       SET status = 'retrying', run_at = ?, last_error = ?,
           claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(nextRunAt, error, now, job.id);
    return { outcome: 'retry', nextRunAt, delayMs };
  }

  db.prepare(
    `UPDATE jobs
     SET status = 'dead', completed_at = ?, last_error = ?,
         claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(now, error, now, job.id);
  db.prepare(
    `INSERT INTO dead_letter_jobs (id, job_id, queue_id, reason, attempts, moved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId.dlq(), job.id, job.queue_id, error, job.attempts, now);
  return { outcome: 'dead' };
}

export function resolveRetryPolicy(db: DB, policyId: string | null): RetryPolicyRow {
  const id = policyId ?? DEFAULT_RETRY_POLICY_ID;
  const policy = db.prepare(`SELECT * FROM retry_policies WHERE id = ?`).get(id) as RetryPolicyRow | undefined;
  if (policy) return policy;
  return db.prepare(`SELECT * FROM retry_policies WHERE id = ?`).get(DEFAULT_RETRY_POLICY_ID) as RetryPolicyRow;
}

/** Heartbeat side-effect: keep leases on this worker's in-flight jobs alive. */
export function extendLeases(db: DB, workerId: string, leaseMs: number, now: number = Date.now()): number {
  return db
    .prepare(
      `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
       WHERE claimed_by = ? AND status IN ('claimed','running')`,
    )
    .run(now + leaseMs, now, workerId).changes;
}

export function appendJobLog(
  db: DB,
  args: { jobId: string; executionId?: string | null; level?: 'debug' | 'info' | 'warn' | 'error'; message: string; now?: number },
): void {
  db.prepare(
    `INSERT INTO job_logs (job_id, execution_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(args.jobId, args.executionId ?? null, args.level ?? 'info', args.message, args.now ?? Date.now());
}

function finishExecution(
  db: DB,
  executionId: string,
  status: ExecutionStatus,
  now: number,
  extra: { error?: string; result?: string | null },
): void {
  db.prepare(
    `UPDATE job_executions
     SET status = ?, finished_at = ?, duration_ms = ? - started_at, error = ?, result = ?
     WHERE id = ? AND status = 'running'`,
  ).run(status, now, now, extra.error ?? null, extra.result ?? null, executionId);
}
