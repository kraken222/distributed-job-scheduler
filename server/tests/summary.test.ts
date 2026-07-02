import { describe, expect, it } from 'vitest';
import { claimJobs } from '../src/core/claims.js';
import { heuristicSummary, summarizeDeadLetters, type FailureContext } from '../src/core/failureSummary.js';
import { createJob } from '../src/core/jobService.js';
import { addWorker, runToFailure, seedFixture, testDb } from './helpers.js';

function ctx(partial: Partial<FailureContext>): FailureContext {
  return {
    jobId: 'job_x',
    jobType: 'email.send',
    queueName: 'default',
    attempts: 3,
    timeoutMs: 60000,
    payload: null,
    executions: [],
    logs: [],
    ...partial,
  };
}

describe('heuristic failure summaries', () => {
  it('flags deterministic failures as not worth blind requeueing', () => {
    const s = heuristicSummary(
      ctx({
        executions: [1, 2, 3].map((attempt) => ({ attempt, status: 'failed', duration_ms: 50, error: 'Invalid API key' })),
      }),
    );
    expect(s).toContain('failed identically');
    expect(s).toMatch(/requeueing without a fix/i);
  });

  it('recognises all-timeout patterns and suggests raising the budget', () => {
    const s = heuristicSummary(
      ctx({
        timeoutMs: 5000,
        executions: [1, 2].map((attempt) => ({ attempt, status: 'timed_out', duration_ms: 5000, error: 'Timed out after 5000ms' })),
      }),
    );
    expect(s).toMatch(/timeout/i);
    expect(s).toMatch(/raise timeoutMs|budget/i);
  });

  it('recognises missing handlers, connectivity issues and HTTP status classes', () => {
    const noHandler = heuristicSummary(
      ctx({ executions: [{ attempt: 1, status: 'failed', duration_ms: 1, error: "No handler registered for job type 'x'" }] }),
    );
    expect(noHandler).toMatch(/deploy a worker/i);

    const conn = heuristicSummary(
      ctx({ executions: [{ attempt: 1, status: 'failed', duration_ms: 1, error: 'connect ECONNREFUSED 10.0.0.5:443' }] }),
    );
    expect(conn).toMatch(/connectivity/i);

    const clientErr = heuristicSummary(
      ctx({ executions: [{ attempt: 1, status: 'failed', duration_ms: 1, error: 'Response 403' }] }),
    );
    expect(clientErr).toMatch(/4xx|permanent/i);
  });

  it('describes mixed errors as flakiness', () => {
    const s = heuristicSummary(
      ctx({
        executions: [
          { attempt: 1, status: 'failed', duration_ms: 10, error: 'socket hang up' },
          { attempt: 2, status: 'failed', duration_ms: 12, error: 'oom killed' },
        ],
      }),
    );
    expect(s).toContain('2 distinct errors');
  });
});

describe('summarizeDeadLetters', () => {
  it('writes a heuristic summary onto fresh DLQ entries (no API key)', async () => {
    const db = testDb();
    const { queueId } = seedFixture(db, { retryPolicyId: 'rp_none' });
    const w = addWorker(db);
    const job = createJob(db, queueId, { type: 'demo.fail' }).job;
    claimJobs(db, w, 1, { leaseMs: 30000 });
    runToFailure(db, w, job.id, 'Permanent simulated failure');

    const done = await summarizeDeadLetters(db, {});
    expect(done).toBe(1);

    const entry = db
      .prepare(`SELECT summary, summary_source FROM dead_letter_jobs WHERE job_id = ?`)
      .get(job.id) as { summary: string; summary_source: string };
    expect(entry.summary_source).toBe('heuristic');
    expect(entry.summary).toContain('demo.fail');
    expect(entry.summary).toContain('Permanent simulated failure');

    // Idempotent: nothing left to summarize on the next tick.
    expect(await summarizeDeadLetters(db, {})).toBe(0);
  });
});
