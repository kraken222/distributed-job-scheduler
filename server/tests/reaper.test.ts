import { describe, expect, it } from 'vitest';
import { claimJobs, startJob } from '../src/core/claims.js';
import { createJob } from '../src/core/jobService.js';
import { reap } from '../src/core/reaper.js';
import { addWorker, seedFixture, testDb } from './helpers.js';

describe('reaper (failure recovery)', () => {
  it('marks stale workers as lost', () => {
    const db = testDb();
    seedFixture(db);
    const w = addWorker(db);
    db.prepare(`UPDATE workers SET last_heartbeat_at = ? WHERE id = ?`).run(Date.now() - 60_000, w);

    const result = reap(db, { workerStaleMs: 15_000 });
    expect(result.lostWorkers).toBe(1);
    expect((db.prepare(`SELECT status FROM workers WHERE id = ?`).get(w) as any).status).toBe('lost');
  });

  it('requeues claimed-but-never-started jobs without consuming an attempt', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const past = Date.now() - 5000;
    const { job } = createJob(db, queueId, { type: 't' }, past);
    claimJobs(db, w, 1, { leaseMs: 1000, now: past }); // lease already expired

    const result = reap(db, { workerStaleMs: 15_000 });
    expect(result.recoveredJobs).toBe(1);
    const row = db.prepare(`SELECT status, attempts, claimed_by FROM jobs WHERE id = ?`).get(job.id) as any;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(row.claimed_by).toBeNull();
  });

  it('treats a lost running job as a failed attempt: closes the execution and retries with backoff', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const past = Date.now() - 60_000;
    const { job } = createJob(db, queueId, { type: 't' }, past);
    claimJobs(db, w, 1, { leaseMs: 1000, now: past });
    startJob(db, job.id, w, past);

    reap(db, { workerStaleMs: 15_000 });

    const row = db.prepare(`SELECT status, attempts FROM jobs WHERE id = ?`).get(job.id) as any;
    expect(row.status).toBe('retrying'); // attempt 1 of 3 consumed
    expect(row.attempts).toBe(1);
    const exec = db.prepare(`SELECT status, finished_at FROM job_executions WHERE job_id = ?`).get(job.id) as any;
    expect(exec.status).toBe('lost');
    expect(exec.finished_at).not.toBeNull();
  });

  it('dead-letters a lost job that already exhausted its attempts', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const past = Date.now() - 60_000;
    const { job } = createJob(db, queueId, { type: 't', retryPolicyId: 'rp_none' }, past); // 1 attempt max
    claimJobs(db, w, 1, { leaseMs: 1000, now: past });
    startJob(db, job.id, w, past);

    reap(db, { workerStaleMs: 15_000 });

    expect((db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(job.id) as any).status).toBe('dead');
    expect(db.prepare(`SELECT COUNT(*) n FROM dead_letter_jobs WHERE job_id = ?`).get(job.id)).toEqual({ n: 1 });
  });

  it('leaves healthy leases alone', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const { job } = createJob(db, queueId, { type: 't' });
    claimJobs(db, w, 1, { leaseMs: 60_000 });

    const result = reap(db, { workerStaleMs: 15_000 });
    expect(result.recoveredJobs).toBe(0);
    expect((db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(job.id) as any).status).toBe('claimed');
  });
});
