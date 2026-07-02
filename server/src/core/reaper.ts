import type { DB } from '../db/connection.js';
import type { JobRow } from '../types.js';
import { applyFailure, appendJobLog, resolveRetryPolicy } from './claims.js';
import { logger } from '../logger.js';

export interface ReaperResult {
  lostWorkers: number;
  recoveredJobs: number;
}

/**
 * Failure recovery. Two responsibilities:
 *
 * 1. Workers that stopped heartbeating are marked `lost`.
 * 2. Jobs whose lease expired (their worker died mid-flight) are recovered:
 *    - `claimed` but never started → returned to the queue as-is (the
 *      attempt never began, so it doesn't count against the retry budget);
 *    - `running` → the open execution is closed as `lost` and the normal
 *      retry policy decides between backoff-retry and the dead letter queue.
 *
 * This is what makes execution *at-least-once*: a crashed worker's jobs
 * always come back, so handlers must be idempotent (documented).
 */
export function reap(db: DB, opts: { workerStaleMs: number; now?: number }): ReaperResult {
  const now = opts.now ?? Date.now();
  const tx = db.transaction((): ReaperResult => {
    const lostWorkers = db
      .prepare(
        `UPDATE workers SET status = 'lost', stopped_at = ?
         WHERE status IN ('online','draining') AND last_heartbeat_at < ?`,
      )
      .run(now, now - opts.workerStaleMs).changes;

    const expired = db
      .prepare(
        `SELECT j.*, q.retry_policy_id AS queue_policy_id
         FROM jobs j JOIN queues q ON q.id = j.queue_id
         WHERE j.status IN ('claimed','running') AND j.lease_expires_at < ?`,
      )
      .all(now) as (JobRow & { queue_policy_id: string | null })[];

    for (const job of expired) {
      if (job.status === 'claimed') {
        db.prepare(
          `UPDATE jobs SET status = 'queued', run_at = ?, claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(now, now, job.id);
        appendJobLog(db, { jobId: job.id, level: 'warn', message: `Claim lease expired (worker ${job.claimed_by}); job returned to queue`, now });
        continue;
      }
      // Close the orphaned execution record before deciding the job's fate.
      db.prepare(
        `UPDATE job_executions SET status = 'lost', finished_at = ?, duration_ms = ? - started_at,
                error = 'worker lost (lease expired)'
         WHERE job_id = ? AND status = 'running'`,
      ).run(now, now, job.id);
      const error = `Worker ${job.claimed_by} lost mid-execution (lease expired)`;
      const policy = resolveRetryPolicy(db, job.retry_policy_id ?? job.queue_policy_id);
      const outcome = applyFailure(db, job, policy, error, now);
      appendJobLog(db, {
        jobId: job.id,
        level: 'warn',
        message: outcome.outcome === 'retry' ? `${error}; retrying in ${outcome.delayMs}ms` : `${error}; moved to dead letter queue`,
        now,
      });
    }
    return { lostWorkers, recoveredJobs: expired.length };
  });

  const result = tx.immediate();
  if (result.lostWorkers > 0 || result.recoveredJobs > 0) {
    logger.warn(result, 'reaper recovered stalled work');
  }
  return result;
}
