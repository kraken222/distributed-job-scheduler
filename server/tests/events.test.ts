import { describe, expect, it } from 'vitest';
import { emitEvent } from '../src/core/events.js';
import { newId } from '../src/core/ids.js';
import type { DB } from '../src/db/connection.js';
import { addQueue, seedFixture, testDb } from './helpers.js';

function addTrigger(
  db: DB,
  projectId: string,
  queueId: string,
  opts: { eventName: string; jobType: string; payload?: unknown; enabled?: boolean; priority?: number },
): string {
  const now = Date.now();
  const id = newId.trigger();
  db.prepare(
    `INSERT INTO event_triggers (id, project_id, queue_id, event_name, job_type, payload, priority, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, projectId, queueId, opts.eventName, opts.jobType,
    opts.payload === undefined ? null : JSON.stringify(opts.payload),
    opts.priority ?? 0, opts.enabled === false ? 0 : 1, now, now,
  );
  return id;
}

describe('event-driven execution', () => {
  it('fans an event out to one job per matching trigger', () => {
    const db = testDb();
    const { projectId, queueId } = seedFixture(db);
    const other = addQueue(db, projectId, 'other');
    addTrigger(db, projectId, queueId, { eventName: 'user.signup', jobType: 'email.send' });
    addTrigger(db, projectId, other, { eventName: 'user.signup', jobType: 'report.generate' });
    addTrigger(db, projectId, queueId, { eventName: 'user.deleted', jobType: 'cleanup' }); // different event

    const { event, jobs } = emitEvent(db, projectId, { name: 'user.signup', payload: { userId: 'u1' } });
    expect(jobs).toHaveLength(2);
    expect(event.jobs_created).toBe(2);
    expect(jobs.map((j) => j.type).sort()).toEqual(['email.send', 'report.generate']);
    expect(jobs.map((j) => j.status)).toEqual(['queued', 'queued']);
  });

  it('merges the trigger payload template with the event envelope', () => {
    const db = testDb();
    const { projectId, queueId } = seedFixture(db);
    addTrigger(db, projectId, queueId, {
      eventName: 'order.placed',
      jobType: 'email.send',
      payload: { template: 'order-confirmation' },
    });

    const { jobs } = emitEvent(db, projectId, { name: 'order.placed', payload: { orderId: 'o-9' } });
    const payload = JSON.parse(jobs[0].payload!);
    expect(payload.template).toBe('order-confirmation');
    expect(payload.event.name).toBe('order.placed');
    expect(payload.event.payload.orderId).toBe('o-9');
    expect(payload.event.id).toMatch(/^evt_/);
  });

  it('ignores disabled triggers and records zero-fan-out events', () => {
    const db = testDb();
    const { projectId, queueId } = seedFixture(db);
    addTrigger(db, projectId, queueId, { eventName: 'ping', jobType: 't', enabled: false });

    const { event, jobs } = emitEvent(db, projectId, { name: 'ping' });
    expect(jobs).toHaveLength(0);
    expect(event.jobs_created).toBe(0);
    // The event itself is still recorded for audit.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?`).get(projectId) as { n: number };
    expect(row.n).toBe(1);
  });

  it('does not leak across projects', () => {
    const db = testDb();
    const { projectId, queueId } = seedFixture(db);
    const otherFixture = seedFixture(db);
    addTrigger(db, projectId, queueId, { eventName: 'shared.name', jobType: 't' });

    const { jobs } = emitEvent(db, otherFixture.projectId, { name: 'shared.name' });
    expect(jobs).toHaveLength(0);
  });
});
