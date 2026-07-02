import type { DB } from '../db/connection.js';
import type { ScheduledJobRow } from '../types.js';
import { nextCronRun } from './cron.js';
import { createJob } from './jobService.js';
import { logger } from '../logger.js';

/**
 * Materialises due recurring (cron) schedules into concrete job rows.
 *
 * Safe to run from multiple processes: advancing next_run_at uses a
 * compare-and-set (`WHERE next_run_at = <value we read>`), so if two
 * scheduler ticks race, exactly one wins and enqueues the job.
 */
export function materializeDueSchedules(db: DB, now: number = Date.now()): number {
  const due = db
    .prepare(`SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at <= ?`)
    .all(now) as ScheduledJobRow[];

  let enqueued = 0;
  for (const s of due) {
    let next: number;
    try {
      next = nextCronRun(s.cron, s.timezone, now);
    } catch (err) {
      // Defensive: expression validated at creation, but disable rather than tight-loop.
      db.prepare(`UPDATE scheduled_jobs SET enabled = 0, updated_at = ? WHERE id = ?`).run(now, s.id);
      logger.error({ scheduleId: s.id, err: (err as Error).message }, 'disabled schedule with invalid cron');
      continue;
    }

    const won = db
      .prepare(
        `UPDATE scheduled_jobs SET next_run_at = ?, last_run_at = ?, updated_at = ?
         WHERE id = ? AND next_run_at = ?`,
      )
      .run(next, s.next_run_at, now, s.id, s.next_run_at).changes;
    if (won === 0) continue; // another scheduler instance beat us to this firing

    createJob(
      db,
      s.queue_id,
      {
        type: s.job_type,
        payload: s.payload === null ? undefined : JSON.parse(s.payload),
        priority: s.priority,
        timeoutMs: s.timeout_ms,
        retryPolicyId: s.retry_policy_id,
        scheduledJobId: s.id,
        // One job per schedule per firing, even if two schedulers race past the CAS.
        idempotencyKey: `sched:${s.id}:${s.next_run_at}`,
      },
      now,
    );
    enqueued++;
  }
  return enqueued;
}
