import { describe, expect, it } from 'vitest';
import { Worker } from '../src/worker/worker.js';
import { createJob } from '../src/core/jobService.js';
import type { JobHandler } from '../src/worker/handlers.js';
import { seedFixture, testDb } from './helpers.js';

const fastOpts = { concurrency: 3, pollMs: 20, heartbeatMs: 50, leaseMs: 5000 };

function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error('condition not met in time'));
      }
    }, 10);
  });
}

describe('worker runtime (integration)', () => {
  it('claims, executes and completes jobs end to end', async () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const registry: Record<string, JobHandler> = {
      ok: async (payload) => ({ echoed: payload }),
    };
    for (let i = 0; i < 5; i++) createJob(db, queueId, { type: 'ok', payload: { i } });

    const worker = new Worker(db, { name: 'itest', ...fastOpts }, registry);
    const run = worker.start();
    await until(() => (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'completed'`).get() as any).n === 5);
    await worker.stop();
    await run;

    const logs = db.prepare(`SELECT COUNT(*) n FROM job_logs`).get() as any;
    expect(logs.n).toBeGreaterThan(0);
    const w = db.prepare(`SELECT status FROM workers WHERE id = ?`).get(worker.workerId) as any;
    expect(w.status).toBe('offline');
  });

  it('never runs more jobs at once than its concurrency setting', async () => {
    const db = testDb();
    const { queueId } = seedFixture(db, { concurrency: 100 });
    let inFlight = 0;
    let peak = 0;
    const registry: Record<string, JobHandler> = {
      slow: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return null;
      },
    };
    for (let i = 0; i < 12; i++) createJob(db, queueId, { type: 'slow' });

    const worker = new Worker(db, { name: 'ctest', ...fastOpts, concurrency: 3 }, registry);
    const run = worker.start();
    await until(() => (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'completed'`).get() as any).n === 12, 10000);
    await worker.stop();
    await run;
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it actually ran concurrently
  });

  it('routes failures through retry and into the DLQ, and honours timeouts', async () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const registry: Record<string, JobHandler> = {
      boom: async () => {
        throw new Error('nope');
      },
      hang: () => new Promise(() => {}), // never resolves → must time out
    };
    createJob(db, queueId, { type: 'boom', retryPolicyId: 'rp_none' });
    createJob(db, queueId, { type: 'hang', retryPolicyId: 'rp_none', timeoutMs: 150 });

    const worker = new Worker(db, { name: 'ftest', ...fastOpts }, registry);
    const run = worker.start();
    await until(() => (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'dead'`).get() as any).n === 2, 10000);
    await worker.stop(500);
    await run;

    const dlq = db.prepare(`SELECT COUNT(*) n FROM dead_letter_jobs`).get() as any;
    expect(dlq.n).toBe(2);
    const timedOut = db.prepare(`SELECT COUNT(*) n FROM job_executions WHERE status = 'timed_out'`).get() as any;
    expect(timedOut.n).toBe(1);
  });

  it('drains gracefully: finishes in-flight work before going offline', async () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const registry: Record<string, JobHandler> = {
      slowish: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'done';
      },
    };
    createJob(db, queueId, { type: 'slowish' });

    const worker = new Worker(db, { name: 'dtest', ...fastOpts }, registry);
    const run = worker.start();
    await until(() => (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'running'`).get() as any).n === 1);

    await worker.stop(); // must wait for the running job
    await run;
    const job = db.prepare(`SELECT status FROM jobs LIMIT 1`).get() as any;
    expect(job.status).toBe('completed');
  });
});
