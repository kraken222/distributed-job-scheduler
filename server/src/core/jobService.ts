import type { DB } from '../db/connection.js';
import type { DeadLetterRow, JobRow } from '../types.js';
import { newId } from './ids.js';
import { appendJobLog } from './claims.js';

export interface CreateJobInput {
  type: string;
  payload?: unknown;
  priority?: number;
  /** Run after this many ms (delayed job). */
  delayMs?: number;
  /** Absolute epoch-ms run time (scheduled job). Wins over delayMs. */
  runAt?: number;
  timeoutMs?: number;
  retryPolicyId?: string | null;
  idempotencyKey?: string | null;
  batchId?: string | null;
  scheduledJobId?: string | null;
}

export interface CreateJobResult {
  job: JobRow;
  /** True when an idempotency key matched an existing job and no new job was created. */
  deduplicated: boolean;
}

export function createJob(db: DB, queueId: string, input: CreateJobInput, now: number = Date.now()): CreateJobResult {
  const runAt = input.runAt ?? now + (input.delayMs ?? 0);
  const status = runAt > now ? 'scheduled' : 'queued';
  const id = newId.job();

  const tx = db.transaction((): CreateJobResult => {
    if (input.idempotencyKey) {
      const existing = db
        .prepare(`SELECT * FROM jobs WHERE queue_id = ? AND idempotency_key = ?`)
        .get(queueId, input.idempotencyKey) as JobRow | undefined;
      if (existing) return { job: existing, deduplicated: true };
    }
    const job = db
      .prepare(
        `INSERT INTO jobs (id, queue_id, type, payload, status, priority, run_at, retry_policy_id,
                           idempotency_key, batch_id, scheduled_job_id, timeout_ms, created_at, updated_at)
         VALUES (@id, @queue_id, @type, @payload, @status, @priority, @run_at, @retry_policy_id,
                 @idempotency_key, @batch_id, @scheduled_job_id, @timeout_ms, @now, @now)
         RETURNING *`,
      )
      .get({
        id,
        queue_id: queueId,
        type: input.type,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
        status,
        priority: input.priority ?? 0,
        run_at: runAt,
        retry_policy_id: input.retryPolicyId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        batch_id: input.batchId ?? null,
        scheduled_job_id: input.scheduledJobId ?? null,
        timeout_ms: input.timeoutMs ?? 60000,
        now,
      }) as JobRow;
    return { job, deduplicated: false };
  });
  return tx.immediate();
}

export function createBatch(
  db: DB,
  queueId: string,
  args: { name?: string; jobs: CreateJobInput[] },
  now: number = Date.now(),
): { batchId: string; jobs: JobRow[] } {
  const tx = db.transaction(() => {
    const batchId = newId.batch();
    db.prepare(`INSERT INTO batches (id, queue_id, name, total, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      batchId,
      queueId,
      args.name ?? null,
      args.jobs.length,
      now,
    );
    const jobs = args.jobs.map((j) => createJob(db, queueId, { ...j, batchId }, now).job);
    return { batchId, jobs };
  });
  return tx.immediate();
}

/** Cancel a job that has not started executing. Running jobs cannot be interrupted (documented trade-off). */
export function cancelJob(db: DB, jobId: string, now: number = Date.now()): JobRow | null {
  const job = db
    .prepare(
      `UPDATE jobs
       SET status = 'canceled', completed_at = ?, claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('scheduled','queued','retrying')
       RETURNING *`,
    )
    .get(now, now, jobId) as JobRow | undefined;
  if (job) appendJobLog(db, { jobId, level: 'warn', message: 'Job canceled by user', now });
  return job ?? null;
}

/**
 * Manual retry: re-queue a terminally failed (or canceled) job with a fresh
 * attempt budget. Reuses the job row so execution history stays attached.
 */
export function retryJobNow(db: DB, jobId: string, actor: string, now: number = Date.now()): JobRow | null {
  const tx = db.transaction((): JobRow | null => {
    const job = db
      .prepare(
        `UPDATE jobs
         SET status = 'queued', run_at = ?, attempts = 0, completed_at = NULL,
             claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('dead','canceled','completed')
         RETURNING *`,
      )
      .get(now, now, jobId) as JobRow | undefined;
    if (!job) {
      // A job waiting on backoff can be nudged to run immediately instead.
      const nudged = db
        .prepare(`UPDATE jobs SET run_at = ?, updated_at = ? WHERE id = ? AND status = 'retrying' RETURNING *`)
        .get(now, now, jobId) as JobRow | undefined;
      if (nudged) appendJobLog(db, { jobId, message: `Retry fast-forwarded by ${actor}`, now });
      return nudged ?? null;
    }
    db.prepare(`UPDATE dead_letter_jobs SET requeued_at = ?, requeued_job_id = ? WHERE job_id = ? AND requeued_at IS NULL`).run(
      now,
      jobId,
      jobId,
    );
    appendJobLog(db, { jobId, message: `Manually re-queued by ${actor}`, now });
    return job;
  });
  return tx.immediate();
}

export function requeueDeadLetter(db: DB, dlqId: string, actor: string, now: number = Date.now()): JobRow | null {
  const entry = db.prepare(`SELECT * FROM dead_letter_jobs WHERE id = ?`).get(dlqId) as DeadLetterRow | undefined;
  if (!entry || entry.requeued_at !== null) return null;
  return retryJobNow(db, entry.job_id, actor, now);
}
