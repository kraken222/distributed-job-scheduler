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
 *  3. per-queue sliding-window rate limits (execution starts in the window
 *     plus claimed-but-not-yet-started jobs consume the budget),
 *  4. workflow dependencies (jobs with incomplete parents are invisible),
 *  5. shard pinning (a worker started with WORKER_SHARDS only sees its shards),
 *  6. queue priority, then job priority, then run_at/created_at (FIFO).
 */
export function claimJobs(
  db: DB,
  workerId: string,
  maxJobs: number,
  opts: { now?: number; leaseMs: number; shards?: number[] },
): JobRow[] {
  const now = opts.now ?? Date.now();
  if (maxJobs <= 0) return [];

  // Optional shard pinning: filter candidates to this worker's shards.
  const shardParams: Record<string, number> = {};
  let shardClause = '';
  if (opts.shards && opts.shards.length > 0) {
    shardClause = ` AND j.shard IN (${opts.shards.map((_, i) => `@sh${i}`).join(',')})`;
    opts.shards.forEach((s, i) => (shardParams[`sh${i}`] = s));
  }

  const tx = db.transaction((): JobRow[] => {
    const candidates = db
      .prepare(
        `WITH capacity AS (
           SELECT q.id AS queue_id, q.priority AS queue_priority,
                  -- Free slots = MIN(concurrency headroom, rate-limit tokens).
                  MIN(
                    q.concurrency_limit
                      - (SELECT COUNT(*) FROM jobs a
                         WHERE a.queue_id = q.id AND a.status IN ('claimed','running')),
                    CASE
                      WHEN q.rate_limit_max IS NULL OR q.rate_limit_window_ms IS NULL THEN 1000000000
                      ELSE q.rate_limit_max
                        -- Execution starts inside the sliding window...
                        - (SELECT COUNT(*) FROM job_executions e JOIN jobs je ON je.id = e.job_id
                           WHERE je.queue_id = q.id AND e.started_at > @now - q.rate_limit_window_ms)
                        -- ...plus claims that will imminently start (not yet in job_executions).
                        - (SELECT COUNT(*) FROM jobs cl
                           WHERE cl.queue_id = q.id AND cl.status = 'claimed')
                    END
                  ) AS free
           FROM queues q
           WHERE q.is_paused = 0
         ),
         candidates AS (
           SELECT j.id, c.queue_priority, c.free,
                  j.priority AS job_priority, j.run_at, j.created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY j.queue_id
                    ORDER BY j.priority DESC, j.run_at ASC, j.created_at ASC
                  ) AS rn
           FROM jobs j
           JOIN capacity c ON c.queue_id = j.queue_id AND c.free > 0
           WHERE j.status IN ('queued','scheduled','retrying') AND j.run_at <= @now
             AND j.pending_deps = 0${shardClause}
         )
         SELECT id FROM candidates
         WHERE rn <= free
         ORDER BY queue_priority DESC, job_priority DESC, run_at ASC, created_at ASC
         LIMIT @max`,
      )
      .all({ now, max: maxJobs, ...shardParams }) as { id: string }[];

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
    // Workflow fan-out: children waiting on this job get one step closer to
    // claimable; at pending_deps = 0 the claim query starts seeing them.
    db.prepare(
      `UPDATE jobs SET pending_deps = pending_deps - 1, updated_at = ?
       WHERE pending_deps > 0
         AND id IN (SELECT job_id FROM job_dependencies WHERE depends_on = ?)`,
    ).run(now, args.jobId);
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
  // A dead parent can never satisfy its children: cancel the whole subtree.
  skipDependents(db, job.id, `dependency ${job.id} failed permanently`, now);
  return { outcome: 'dead' };
}

/**
 * Cancel every not-yet-started descendant of a failed/canceled job
 * (recursive: grandchildren too). Children keep their pending_deps counter,
 * so a manual retry of the child stays gated until the parent is retried
 * and completes — the DAG contract survives manual intervention.
 */
export function skipDependents(db: DB, jobId: string, reason: string, now: number = Date.now()): string[] {
  const skipped = db
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT job_id FROM job_dependencies WHERE depends_on = ?
         UNION
         SELECT d.job_id FROM job_dependencies d JOIN descendants ON descendants.id = d.depends_on
       )
       UPDATE jobs
       SET status = 'canceled', completed_at = ?, last_error = ?,
           claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id IN (SELECT id FROM descendants)
         AND status IN ('scheduled','queued','retrying')
       RETURNING id`,
    )
    .all(jobId, now, reason, now) as { id: string }[];
  for (const row of skipped) {
    appendJobLog(db, { jobId: row.id, level: 'warn', message: `Canceled: ${reason}`, now });
  }
  return skipped.map((r) => r.id);
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
