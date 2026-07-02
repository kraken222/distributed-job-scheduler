import { describe, expect, it } from 'vitest';
import { claimJobs } from '../src/core/claims.js';
import { cancelJob, createJob, createWorkflow, DependencyError } from '../src/core/jobService.js';
import { addWorker, runToCompletion, runToFailure, seedFixture, testDb } from './helpers.js';

const LEASE = { leaseMs: 30000 };

describe('workflow dependencies', () => {
  it('gates a child until every parent has completed', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);

    const p1 = createJob(db, queueId, { type: 'extract.a' }).job;
    const p2 = createJob(db, queueId, { type: 'extract.b' }).job;
    const child = createJob(db, queueId, { type: 'transform', dependsOn: [p1.id, p2.id] }).job;
    expect(child.pending_deps).toBe(2);

    // Child is invisible to the claim query while parents are incomplete.
    let claimed = claimJobs(db, w, 10, LEASE);
    expect(claimed.map((j) => j.id).sort()).toEqual([p1.id, p2.id].sort());

    runToCompletion(db, w, p1.id);
    expect(claimJobs(db, w, 10, LEASE)).toHaveLength(0); // still one parent left

    runToCompletion(db, w, p2.id);
    claimed = claimJobs(db, w, 10, LEASE);
    expect(claimed.map((j) => j.id)).toEqual([child.id]);
  });

  it('does not count already-completed parents', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);
    const parent = createJob(db, queueId, { type: 'p' }).job;
    claimJobs(db, w, 1, LEASE);
    runToCompletion(db, w, parent.id);

    const child = createJob(db, queueId, { type: 'c', dependsOn: [parent.id] }).job;
    expect(child.pending_deps).toBe(0);
    expect(claimJobs(db, w, 10, LEASE).map((j) => j.id)).toEqual([child.id]);
  });

  it('rejects dependencies on unknown / dead / canceled jobs', () => {
    const db = testDb();
    const { queueId } = seedFixture(db, { retryPolicyId: 'rp_none' });
    const w = addWorker(db);

    expect(() => createJob(db, queueId, { type: 'c', dependsOn: ['job_nope'] })).toThrow(DependencyError);

    const doomed = createJob(db, queueId, { type: 'd' }).job;
    claimJobs(db, w, 1, LEASE);
    runToFailure(db, w, doomed.id); // rp_none: one attempt -> dead
    expect(() => createJob(db, queueId, { type: 'c', dependsOn: [doomed.id] })).toThrow(/dead/);
  });

  it('cancels the whole descendant subtree when a parent dies', () => {
    const db = testDb();
    const { queueId } = seedFixture(db, { retryPolicyId: 'rp_none' });
    const w = addWorker(db);

    const parent = createJob(db, queueId, { type: 'p' }).job;
    const child = createJob(db, queueId, { type: 'c', dependsOn: [parent.id] }).job;
    const grandchild = createJob(db, queueId, { type: 'g', dependsOn: [child.id] }).job;

    claimJobs(db, w, 1, LEASE);
    const outcome = runToFailure(db, w, parent.id);
    expect(outcome?.outcome).toBe('dead');

    const statuses = db
      .prepare(`SELECT id, status FROM jobs WHERE id IN (?, ?)`)
      .all(child.id, grandchild.id) as { id: string; status: string }[];
    expect(statuses.every((s) => s.status === 'canceled')).toBe(true);
  });

  it('cancels dependents when a parent is canceled by the user', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const parent = createJob(db, queueId, { type: 'p', delayMs: 60_000 }).job;
    const child = createJob(db, queueId, { type: 'c', dependsOn: [parent.id] }).job;

    expect(cancelJob(db, parent.id)).not.toBeNull();
    const row = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(child.id) as { status: string };
    expect(row.status).toBe('canceled');
  });
});

describe('createWorkflow (DAG)', () => {
  it('creates a diamond DAG that executes level by level', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const w = addWorker(db);

    const { jobs } = createWorkflow(db, queueId, {
      name: 'etl',
      jobs: [
        { key: 'load', type: 'load', dependsOn: ['left', 'right'] }, // listed first on purpose
        { key: 'extract', type: 'extract' },
        { key: 'left', type: 't.left', dependsOn: ['extract'] },
        { key: 'right', type: 't.right', dependsOn: ['extract'] },
      ],
    });

    // Level 1: only extract is claimable.
    let claimed = claimJobs(db, w, 10, LEASE);
    expect(claimed.map((j) => j.id)).toEqual([jobs['extract'].id]);
    runToCompletion(db, w, jobs['extract'].id);

    // Level 2: both branches, but not the final join.
    claimed = claimJobs(db, w, 10, LEASE);
    expect(claimed.map((j) => j.id).sort()).toEqual([jobs['left'].id, jobs['right'].id].sort());
    runToCompletion(db, w, jobs['left'].id);
    runToCompletion(db, w, jobs['right'].id);

    // Level 3: the join.
    claimed = claimJobs(db, w, 10, LEASE);
    expect(claimed.map((j) => j.id)).toEqual([jobs['load'].id]);
  });

  it('groups workflow jobs under one batch id', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const { batchId, jobs } = createWorkflow(db, queueId, {
      jobs: [{ key: 'a', type: 'a' }, { key: 'b', type: 'b', dependsOn: ['a'] }],
    });
    expect(jobs['a'].batch_id).toBe(batchId);
    expect(jobs['b'].batch_id).toBe(batchId);
  });

  it('rejects cycles, self-references, duplicate and unknown keys', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);

    expect(() =>
      createWorkflow(db, queueId, {
        jobs: [
          { key: 'a', type: 'a', dependsOn: ['b'] },
          { key: 'b', type: 'b', dependsOn: ['a'] },
        ],
      }),
    ).toThrow(/cycle/);

    expect(() => createWorkflow(db, queueId, { jobs: [{ key: 'a', type: 'a', dependsOn: ['a'] }] })).toThrow(
      /itself/,
    );
    expect(() =>
      createWorkflow(db, queueId, { jobs: [{ key: 'a', type: 'a' }, { key: 'a', type: 'b' }] }),
    ).toThrow(/unique/);
    expect(() => createWorkflow(db, queueId, { jobs: [{ key: 'a', type: 'a', dependsOn: ['zz'] }] })).toThrow(
      /unknown key/,
    );
    // Nothing partial leaked out of the failed transactions.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(0);
  });
});
