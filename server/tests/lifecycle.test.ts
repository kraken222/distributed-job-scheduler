import { describe, expect, it } from 'vitest';
import { claimJobs, completeJob, failJob, startJob } from '../src/core/claims.js';
import { cancelJob, createJob, retryJobNow } from '../src/core/jobService.js';
import type { JobRow } from '../src/types.js';
import { addWorker, seedFixture, testDb } from './helpers.js';

const LEASE = { leaseMs: 30000 };

function getJob(db: ReturnType<typeof testDb>, id: string): JobRow {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow;
}

describe('job lifecycle', () => {
  it('walks queued → claimed → running → completed', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const { job } = createJob(db, queueId, { type: 'email.send', payload: { to: 'a@b.c' } });
    expect(job.status).toBe('queued');

    const [claimed] = claimJobs(db, w, 1, LEASE);
    expect(claimed.id).toBe(job.id);
    expect(getJob(db, job.id).status).toBe('claimed');

    const started = startJob(db, job.id, w)!;
    expect(started.attempt).toBe(1);
    expect(getJob(db, job.id).status).toBe('running');

    expect(completeJob(db, { jobId: job.id, executionId: started.executionId, workerId: w, result: { ok: 1 } })).toBe(true);
    const final = getJob(db, job.id);
    expect(final.status).toBe('completed');
    expect(final.claimed_by).toBeNull();
    expect(JSON.parse(final.result!)).toEqual({ ok: 1 });

    const exec = db.prepare(`SELECT * FROM job_executions WHERE job_id = ?`).all(job.id) as any[];
    expect(exec.length).toBe(1);
    expect(exec[0].status).toBe('completed');
    expect(exec[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('delayed jobs start life as scheduled', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const { job } = createJob(db, queueId, { type: 't', delayMs: 60_000 });
    expect(job.status).toBe('scheduled');
    expect(job.run_at).toBeGreaterThan(Date.now() + 50_000);
  });

  it('failure schedules a retry with backoff, then dead-letters after max attempts', () => {
    const db = testDb();
    // default policy: exponential, 3 attempts, base 1000ms
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const { job } = createJob(db, queueId, { type: 'demo.fail' });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = Date.now() + attempt * 120_000; // jump past any backoff
      const [claimed] = claimJobs(db, w, 1, { leaseMs: 30000, now });
      expect(claimed?.id).toBe(job.id);
      const started = startJob(db, job.id, w, now)!;
      expect(started.attempt).toBe(attempt);
      const outcome = failJob(db, { jobId: job.id, executionId: started.executionId, workerId: w, error: 'boom', now })!;
      if (attempt < 3) {
        expect(outcome.outcome).toBe('retry');
        const row = getJob(db, job.id);
        expect(row.status).toBe('retrying');
        expect(row.run_at).toBeGreaterThan(now); // backoff applied
      } else {
        expect(outcome.outcome).toBe('dead');
      }
    }

    expect(getJob(db, job.id).status).toBe('dead');
    const dlq = db.prepare(`SELECT * FROM dead_letter_jobs WHERE job_id = ?`).all(job.id) as any[];
    expect(dlq.length).toBe(1);
    expect(dlq[0].attempts).toBe(3);
    expect(db.prepare(`SELECT COUNT(*) n FROM job_executions WHERE job_id = ?`).get(job.id)).toEqual({ n: 3 });
  });

  it('respects a job-level retry policy override', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const { job } = createJob(db, queueId, { type: 't', retryPolicyId: 'rp_none' }); // max_attempts = 1

    const [claimed] = claimJobs(db, w, 1, LEASE);
    const started = startJob(db, claimed.id, w)!;
    const outcome = failJob(db, { jobId: job.id, executionId: started.executionId, workerId: w, error: 'x' })!;
    expect(outcome.outcome).toBe('dead');
  });

  it('cancel works only before execution', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const { job: cancellable } = createJob(db, queueId, { type: 't', delayMs: 60_000 });
    expect(cancelJob(db, cancellable.id)!.status).toBe('canceled');

    const { job: running } = createJob(db, queueId, { type: 't' });
    claimJobs(db, w, 1, LEASE);
    startJob(db, running.id, w);
    expect(cancelJob(db, running.id)).toBeNull();
  });

  it('manual retry resurrects a dead job and marks the DLQ entry requeued', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const { job } = createJob(db, queueId, { type: 't', retryPolicyId: 'rp_none' });
    claimJobs(db, w, 1, LEASE);
    const started = startJob(db, job.id, w)!;
    failJob(db, { jobId: job.id, executionId: started.executionId, workerId: w, error: 'x' });
    expect(getJob(db, job.id).status).toBe('dead');

    const revived = retryJobNow(db, job.id, 'tester')!;
    expect(revived.status).toBe('queued');
    expect(revived.attempts).toBe(0);
    const dlq = db.prepare(`SELECT requeued_at FROM dead_letter_jobs WHERE job_id = ?`).get(job.id) as any;
    expect(dlq.requeued_at).not.toBeNull();
  });

  it('idempotency keys deduplicate job creation per queue', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const first = createJob(db, queueId, { type: 't', idempotencyKey: 'order-42' });
    const second = createJob(db, queueId, { type: 't', idempotencyKey: 'order-42' });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(db.prepare(`SELECT COUNT(*) n FROM jobs`).get()).toEqual({ n: 1 });
  });

  it('a worker cannot complete a job it does not own', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w1 = addWorker(db, 'w1');
    const w2 = addWorker(db, 'w2');
    const { job } = createJob(db, queueId, { type: 't' });
    claimJobs(db, w1, 1, LEASE);
    const started = startJob(db, job.id, w1)!;
    expect(completeJob(db, { jobId: job.id, executionId: started.executionId, workerId: w2 })).toBe(false);
    expect(getJob(db, job.id).status).toBe('running');
  });
});
