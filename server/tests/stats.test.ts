import { describe, expect, it } from 'vitest';
import { claimJobs, completeJob, failJob, startJob } from '../src/core/claims.js';
import { createJob } from '../src/core/jobService.js';
import { projectThroughput, queueStats } from '../src/core/stats.js';
import { addWorker, seedFixture, testDb } from './helpers.js';

describe('metrics', () => {
  it('buckets throughput by minute (regression: REAL division left every row in its own bucket)', () => {
    const db = testDb();
    const { projectId, queueId } = seedFixture(db);
    const w = addWorker(db);

    // Finish three jobs within the same minute, one failing.
    const base = Date.now() - 5 * 60_000;
    for (let i = 0; i < 3; i++) {
      const { job } = createJob(db, queueId, { type: 't', retryPolicyId: 'rp_none' }, base);
      claimJobs(db, w, 1, { leaseMs: 30000, now: base + i });
      const started = startJob(db, job.id, w, base + i)!;
      if (i === 2) {
        failJob(db, { jobId: job.id, executionId: started.executionId, workerId: w, error: 'x', now: base + 1000 + i });
      } else {
        completeJob(db, { jobId: job.id, executionId: started.executionId, workerId: w, now: base + 1000 + i });
      }
    }

    const buckets = projectThroughput(db, projectId, { minutes: 10 });
    const nonEmpty = buckets.filter((b) => b.completed + b.failed > 0);
    expect(nonEmpty.length).toBe(1); // all three collapse into one minute bucket
    expect(nonEmpty[0].completed).toBe(2);
    expect(nonEmpty[0].failed).toBe(1);
    // Densified: the range is fully covered even where nothing happened.
    expect(buckets.length).toBeGreaterThan(8);
  });

  it('queueStats aggregates status counts and last-hour outcomes', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    createJob(db, queueId, { type: 't', delayMs: 60_000 });
    const { job } = createJob(db, queueId, { type: 't' });
    claimJobs(db, w, 1, { leaseMs: 30000 });
    const started = startJob(db, job.id, w)!;
    completeJob(db, { jobId: job.id, executionId: started.executionId, workerId: w });

    const stats = queueStats(db, queueId);
    expect(stats.depth).toBe(1); // the delayed job
    expect(stats.byStatus.completed).toBe(1);
    expect(stats.completedLastHour).toBe(1);
    expect(stats.failedLastHour).toBe(0);
    expect(stats.avgDurationMs).not.toBeNull();
  });
});
