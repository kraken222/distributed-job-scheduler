import type { DB } from '../db/connection.js';
import type { EventRow, EventTriggerRow, JobRow } from '../types.js';
import { newId } from './ids.js';
import { createJob } from './jobService.js';
import { appendJobLog } from './claims.js';

/**
 * Event-driven execution. External systems POST named events; every enabled
 * trigger registered for that (project, event name) fans out into a job.
 *
 * The event insert and the fan-out commit atomically, so an emitted event is
 * never half-processed: either the event row and all its jobs exist, or none
 * do. Job payloads carry the full event envelope under `event`, merged over
 * the trigger's static payload template.
 */
export function emitEvent(
  db: DB,
  projectId: string,
  input: { name: string; payload?: unknown },
  now: number = Date.now(),
): { event: EventRow; jobs: JobRow[] } {
  const tx = db.transaction(() => {
    const eventId = newId.event();
    const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);

    const triggers = db
      .prepare(
        `SELECT * FROM event_triggers
         WHERE project_id = ? AND event_name = ? AND enabled = 1
         ORDER BY created_at`,
      )
      .all(projectId, input.name) as EventTriggerRow[];

    const jobs: JobRow[] = [];
    for (const t of triggers) {
      const template = t.payload === null ? {} : (JSON.parse(t.payload) as Record<string, unknown>);
      const { job } = createJob(
        db,
        t.queue_id,
        {
          type: t.job_type,
          priority: t.priority,
          payload: {
            ...template,
            event: { id: eventId, name: input.name, payload: input.payload ?? null, emittedAt: now },
          },
        },
        now,
      );
      appendJobLog(db, { jobId: job.id, message: `Created by trigger ${t.id} for event '${input.name}' (${eventId})`, now });
      jobs.push(job);
    }

    const event = db
      .prepare(
        `INSERT INTO events (id, project_id, name, payload, jobs_created, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(eventId, projectId, input.name, payloadJson, jobs.length, now) as EventRow;
    return { event, jobs };
  });
  return tx.immediate();
}
