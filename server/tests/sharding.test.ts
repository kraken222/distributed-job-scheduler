import { describe, expect, it } from 'vitest';
import { claimJobs } from '../src/core/claims.js';
import { createJob } from '../src/core/jobService.js';
import { fnv1a, parseShardList, shardFor } from '../src/core/shard.js';
import { addQueue, addWorker, seedFixture, testDb } from './helpers.js';

const LEASE = { leaseMs: 30000 };

describe('shard assignment', () => {
  it('is deterministic and stable for a given key', () => {
    expect(shardFor('user-42', 8)).toBe(shardFor('user-42', 8));
    expect(fnv1a('user-42')).toBe(fnv1a('user-42'));
    expect(shardFor('anything', 1)).toBe(0);
  });

  it('places all jobs with the same shard key on the same shard', () => {
    const db = testDb();
    const { projectId } = seedFixture(db);
    const sharded = addQueue(db, projectId, 'sharded', { shardCount: 4 });
    const shards = new Set(
      Array.from({ length: 5 }, () => createJob(db, sharded, { type: 't', shardKey: 'tenant-7' }).job.shard),
    );
    expect(shards.size).toBe(1);
    expect([...shards][0]).toBe(shardFor('tenant-7', 4));
  });

  it('spreads keyless jobs across shards (hash of job id)', () => {
    const db = testDb();
    const { projectId } = seedFixture(db);
    const sharded = addQueue(db, projectId, 'sharded', { shardCount: 4 });
    const shards = new Set(Array.from({ length: 40 }, () => createJob(db, sharded, { type: 't' }).job.shard));
    expect(shards.size).toBeGreaterThan(1); // astronomically unlikely to collapse to one shard
    for (const s of shards) expect(s).toBeGreaterThanOrEqual(0);
    for (const s of shards) expect(s).toBeLessThan(4);
  });

  it('lets a pinned worker claim only its shards; unpinned workers see everything', () => {
    const db = testDb();
    const { projectId } = seedFixture(db);
    const sharded = addQueue(db, projectId, 'sharded', { shardCount: 4, concurrency: 100 });
    const pinned = addWorker(db, 'pinned');
    const roving = addWorker(db, 'roving');
    const jobs = Array.from({ length: 20 }, () => createJob(db, sharded, { type: 't' }).job);
    const myShards = [0, 1];
    const mine = jobs.filter((j) => myShards.includes(j.shard));

    const claimed = claimJobs(db, pinned, 20, { ...LEASE, shards: myShards });
    expect(claimed.map((j) => j.id).sort()).toEqual(mine.map((j) => j.id).sort());
    for (const j of claimed) expect(myShards).toContain(j.shard);

    // The unpinned worker mops up the remaining shards.
    const rest = claimJobs(db, roving, 20, LEASE);
    expect(rest).toHaveLength(jobs.length - mine.length);
  });

  it('parses WORKER_SHARDS and rejects garbage', () => {
    expect(parseShardList(undefined)).toBeUndefined();
    expect(parseShardList('')).toBeUndefined();
    expect(parseShardList('0, 2,2')).toEqual([0, 2]);
    expect(() => parseShardList('0,x')).toThrow(/WORKER_SHARDS/);
    expect(() => parseShardList('-1')).toThrow(/WORKER_SHARDS/);
  });
});
