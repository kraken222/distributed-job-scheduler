import { describe, expect, it } from 'vitest';
import { assertValidCron, nextCronRun } from '../src/core/cron.js';
import { materializeDueSchedules } from '../src/core/scheduler.js';
import { newId } from '../src/core/ids.js';
import { seedFixture, testDb } from './helpers.js';
import type { DB } from '../src/db/connection.js';

function addSchedule(db: DB, queueId: string, cron: string, nextRunAt: number): string {
  const id = newId.schedule();
  const now = Date.now();
  db.prepare(
    `INSERT INTO scheduled_jobs (id, queue_id, name, cron, timezone, job_type, payload, priority, timeout_ms, enabled, next_run_at, created_at, updated_at)
     VALUES (?, ?, 'test-sched', ?, 'UTC', 'demo.sleep', NULL, 0, 60000, 1, ?, ?, ?)`,
  ).run(id, queueId, cron, nextRunAt, now, now);
  return id;
}

describe('cron helpers', () => {
  it('accepts valid and rejects invalid expressions', () => {
    expect(() => assertValidCron('*/5 * * * *')).not.toThrow();
    expect(() => assertValidCron('0 9 * * MON-FRI')).not.toThrow();
    expect(() => assertValidCron('not a cron')).toThrow(/Invalid cron/);
    expect(() => assertValidCron('99 * * * *')).toThrow(/Invalid cron/);
  });

  it('computes the next run strictly after the reference time', () => {
    const base = Date.UTC(2026, 0, 1, 12, 0, 30);
    const next = nextCronRun('* * * * *', 'UTC', base);
    expect(next).toBe(Date.UTC(2026, 0, 1, 12, 1, 0));
  });
});

describe('schedule materialization', () => {
  it('enqueues one job for a due schedule and advances next_run_at', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const schedId = addSchedule(db, queueId, '* * * * *', Date.now() - 1000);

    expect(materializeDueSchedules(db)).toBe(1);

    const jobs = db.prepare(`SELECT * FROM jobs WHERE scheduled_job_id = ?`).all(schedId) as any[];
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe('queued');
    const sched = db.prepare(`SELECT next_run_at, last_run_at FROM scheduled_jobs WHERE id = ?`).get(schedId) as any;
    expect(sched.next_run_at).toBeGreaterThan(Date.now());
  });

  it('is idempotent: a second tick for the same firing enqueues nothing', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    addSchedule(db, queueId, '* * * * *', Date.now() - 1000);

    expect(materializeDueSchedules(db)).toBe(1);
    expect(materializeDueSchedules(db)).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) n FROM jobs`).get() as any).n).toBe(1);
  });

  it('ignores disabled schedules', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    const id = addSchedule(db, queueId, '* * * * *', Date.now() - 1000);
    db.prepare(`UPDATE scheduled_jobs SET enabled = 0 WHERE id = ?`).run(id);
    expect(materializeDueSchedules(db)).toBe(0);
  });

  it('ignores schedules that are not yet due', () => {
    const db = testDb();
    const { queueId } = seedFixture(db);
    addSchedule(db, queueId, '* * * * *', Date.now() + 60_000);
    expect(materializeDueSchedules(db)).toBe(0);
  });
});
