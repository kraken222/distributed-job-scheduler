import { describe, expect, it } from 'vitest';
import { claimJobs, startJob } from '../src/core/claims.js';
import { createJob } from '../src/core/jobService.js';
import { addQueue, addWorker, runToCompletion, seedFixture, testDb } from './helpers.js';

describe('sliding-window rate limiting', () => {
  it('caps claims at rate_limit_max per window even with free concurrency', () => {
    const db = testDb();
    const { projectId } = seedFixture(db);
    const limited = addQueue(db, projectId, 'limited', { concurrency: 100, rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    const w = addWorker(db);
    for (let i = 0; i < 5; i++) createJob(db, limited, { type: 't' });

    const now = Date.now();
    expect(claimJobs(db, w, 10, { leaseMs: 30000, now })).toHaveLength(2);
    // Budget exhausted by the pending claims themselves.
    expect(claimJobs(db, w, 10, { leaseMs: 30000, now })).toHaveLength(0);
  });

  it('keeps counting completed executions until the window slides past them', () => {
    const db = testDb();
    const { projectId } = seedFixture(db);
    const limited = addQueue(db, projectId, 'limited', { concurrency: 100, rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    const w = addWorker(db);
    for (let i = 0; i < 5; i++) createJob(db, limited, { type: 't' });

    const t0 = Date.now();
    const first = claimJobs(db, w, 10, { leaseMs: 30000, now: t0 });
    for (const j of first) runToCompletion(db, w, j.id, t0);

    // Same window: the two finished starts still consume the budget.
    expect(claimJobs(db, w, 10, { leaseMs: 30000, now: t0 + 1000 })).toHaveLength(0);

    // Window slides past the old starts -> two fresh tokens.
    const later = claimJobs(db, w, 10, { leaseMs: 30000, now: t0 + 61_000 });
    expect(later).toHaveLength(2);
  });

  it('applies MIN(concurrency, rate tokens) and leaves other queues unaffected', () => {
    const db = testDb();
    const { projectId, queueId: normal } = seedFixture(db);
    const limited = addQueue(db, projectId, 'limited', { concurrency: 1, rateLimitMax: 50, rateLimitWindowMs: 60_000 });
    const w = addWorker(db);
    createJob(db, limited, { type: 't' });
    createJob(db, limited, { type: 't' });
    for (let i = 0; i < 3; i++) createJob(db, normal, { type: 't' });

    const claimed = claimJobs(db, w, 10, { leaseMs: 30000 });
    // limited contributes 1 (concurrency bound, not rate bound); normal contributes 3.
    expect(claimed.filter((j) => j.queue_id === limited)).toHaveLength(1);
    expect(claimed.filter((j) => j.queue_id === normal)).toHaveLength(3);
  });

  it('counts running-but-unfinished starts against the window', () => {
    const db = testDb();
    const { projectId } = seedFixture(db);
    const limited = addQueue(db, projectId, 'limited', { concurrency: 100, rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    const w = addWorker(db);
    createJob(db, limited, { type: 't' });
    createJob(db, limited, { type: 't' });

    const now = Date.now();
    const [job] = claimJobs(db, w, 10, { leaseMs: 30000, now });
    startJob(db, job.id, w, now); // claimed -> running (start recorded)
    expect(claimJobs(db, w, 10, { leaseMs: 30000, now: now + 1000 })).toHaveLength(0);
  });
});
