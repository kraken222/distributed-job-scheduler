import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/connection.js';
import { newId } from '../../core/ids.js';
import { emitEvent } from '../../core/events.js';
import { getProject, getQueue } from '../access.js';
import { ApiError, h, paginated, parsePagination, parseJson } from '../http.js';
import { validateBody } from '../middleware.js';

const emitSchema = z.object({
  name: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash, underscore only'),
  payload: z.unknown().optional(),
});

const triggerSchema = z.object({
  eventName: z.string().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash, underscore only'),
  queueId: z.string().min(1),
  jobType: z.string().min(1).max(200),
  payload: z.unknown().optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  enabled: z.boolean().default(true),
});

/** Event-driven execution: emit events, manage the triggers that fan them out into jobs. */
export function eventRoutes(db: DB): Router {
  const r = Router();

  // ---- Emit + inspect events ----

  r.post('/projects/:projectId/events', validateBody(emitSchema), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const { event, jobs } = emitEvent(db, project.id, { name: req.body.name, payload: req.body.payload });
    res.status(201).json({
      ...event,
      payload: parseJson(event.payload),
      jobIds: jobs.map((j) => j.id),
    });
  }));

  r.get('/projects/:projectId/events', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const p = parsePagination(req);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE project_id = ?`).get(project.id) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(project.id, p.limit, p.offset) as { payload: string | null }[];
    res.json(paginated(rows.map((e) => ({ ...e, payload: parseJson(e.payload) })), total, p));
  }));

  // ---- Trigger CRUD (project-scoped for tenancy) ----

  r.get('/projects/:projectId/triggers', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const rows = db
      .prepare(
        `SELECT t.*, q.name AS queue_name FROM event_triggers t JOIN queues q ON q.id = t.queue_id
         WHERE t.project_id = ? ORDER BY t.event_name, t.created_at`,
      )
      .all(project.id) as { payload: string | null }[];
    res.json({ data: rows.map((t) => ({ ...t, payload: parseJson(t.payload) })) });
  }));

  r.post('/projects/:projectId/triggers', validateBody(triggerSchema), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const queue = getQueue(db, req.body.queueId, req.user!.orgId);
    if (queue.project_id !== project.id) throw ApiError.badRequest('Queue belongs to a different project');
    const now = Date.now();
    const row = db
      .prepare(
        `INSERT INTO event_triggers (id, project_id, queue_id, event_name, job_type, payload, priority, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        newId.trigger(), project.id, queue.id, req.body.eventName, req.body.jobType,
        req.body.payload === undefined ? null : JSON.stringify(req.body.payload),
        req.body.priority, req.body.enabled ? 1 : 0, now, now,
      );
    res.status(201).json(row);
  }));

  r.patch('/projects/:projectId/triggers/:triggerId', validateBody(triggerSchema.partial()), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const t = db
      .prepare(`SELECT * FROM event_triggers WHERE id = ? AND project_id = ?`)
      .get(req.params.triggerId, project.id) as
      | { id: string; queue_id: string; event_name: string; job_type: string; payload: string | null; priority: number; enabled: number }
      | undefined;
    if (!t) throw ApiError.notFound('Trigger');
    if (req.body.queueId) {
      const queue = getQueue(db, req.body.queueId, req.user!.orgId);
      if (queue.project_id !== project.id) throw ApiError.badRequest('Queue belongs to a different project');
    }
    const row = db
      .prepare(
        `UPDATE event_triggers
         SET queue_id = ?, event_name = ?, job_type = ?, payload = ?, priority = ?, enabled = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        req.body.queueId ?? t.queue_id,
        req.body.eventName ?? t.event_name,
        req.body.jobType ?? t.job_type,
        req.body.payload === undefined ? t.payload : JSON.stringify(req.body.payload),
        req.body.priority ?? t.priority,
        req.body.enabled === undefined ? t.enabled : req.body.enabled ? 1 : 0,
        Date.now(), t.id,
      );
    res.json(row);
  }));

  r.delete('/projects/:projectId/triggers/:triggerId', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const changes = db
      .prepare(`DELETE FROM event_triggers WHERE id = ? AND project_id = ?`)
      .run(req.params.triggerId, project.id).changes;
    if (changes === 0) throw ApiError.notFound('Trigger');
    res.status(204).end();
  }));

  return r;
}
