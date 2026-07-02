import { describe, expect, it } from 'vitest';
import { claimJobs } from '../src/core/claims.js';
import { createJob } from '../src/core/jobService.js';
import { addQueue, addWorker, seedFixture, testDb } from './helpers.js';

const LEASE = { leaseMs: 30000 };

describe('atomic job claiming', () => {
  it('never hands the same job to two workers', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w1 = addWorker(db, 'w1');
    const w2 = addWorker(db, 'w2');
    for (let i = 0; i < 10; i++) createJob(db, queueId, { type: 'demo.sleep' });

    const a = claimJobs(db, w1, 7, LEASE);
    const b = claimJobs(db, w2, 7, LEASE);

    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(a.length + b.length).toBe(10);
    for (const j of a) expect(j.claimed_by).toBe(w1);
    for (const j of b) expect(j.claimed_by).toBe(w2);
  });

  it('does not claim jobs scheduled in the future', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    createJob(db, queueId, { type: 't', delayMs: 60_000 });
    createJob(db, queueId, { type: 't' });

    const claimed = claimJobs(db, w, 10, LEASE);
    expect(claimed.length).toBe(1);

    // ...but claims them once their run_at has passed.
    const later = claimJobs(db, w, 10, { ...LEASE, now: Date.now() + 61_000 });
    expect(later.length).toBe(1);
  });

  it('skips paused queues entirely', () => {
    const db = testDb();
    const { projectId, queueId } = seedFixture(db);
    const paused = addQueue(db, projectId, 'paused', { paused: true });
    const w = addWorker(db);
    createJob(db, paused, { type: 't' });
    createJob(db, queueId, { type: 't' });

    const claimed = claimJobs(db, w, 10, LEASE);
    expect(claimed.length).toBe(1);
    expect(claimed[0].queue_id).toBe(queueId);
  });

  it('respects per-queue concurrency limits across the fleet', () => {
    const db = testDb();
    const { queueId } = seedFixture(db, { concurrency: 3 });
    const w1 = addWorker(db, 'w1');
    const w2 = addWorker(db, 'w2');
    for (let i = 0; i < 10; i++) createJob(db, queueId, { type: 't' });

    expect(claimJobs(db, w1, 10, LEASE).length).toBe(3);
    // Queue is saturated: 3 jobs already claimed count against the limit.
    expect(claimJobs(db, w2, 10, LEASE).length).toBe(0);
  });

  it('orders by queue priority, then job priority, then FIFO', () => {
    const db = testDb();
    const { projectId, queueId: lowQ } = seedFixture(db, { priority: 0 });
    const highQ = addQueue(db, projectId, 'high', { priority: 10 });
    const w = addWorker(db);

    const j1 = createJob(db, lowQ, { type: 'low-normal' }).job;
    const j2 = createJob(db, highQ, { type: 'high-normal' }).job;
    const j3 = createJob(db, highQ, { type: 'high-urgent', priority: 5 }).job;

    const claimed = claimJobs(db, w, 3, LEASE);
    expect(claimed.map((j) => j.id)).toEqual([j3.id, j2.id, j1.id]);
  });

  it('sets a lease that expires in the future', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    createJob(db, queueId, { type: 't' });
    const now = Date.now();
    const [job] = claimJobs(db, w, 1, { leaseMs: 30000, now });
    expect(job.lease_expires_at).toBe(now + 30000);
    expect(job.status).toBe('claimed');
  });
});
