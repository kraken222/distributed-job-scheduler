import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/connection.js';
import { newId } from '../../core/ids.js';
import { projectOverview, projectThroughput } from '../../core/stats.js';
import { RETRY_STRATEGIES } from '../../types.js';
import { getProject } from '../access.js';
import { ApiError, h, paginated, parsePagination } from '../http.js';
import { requireRole, validateBody } from '../middleware.js';

const projectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
});

const retryPolicySchema = z.object({
  name: z.string().min(1).max(100),
  strategy: z.enum(RETRY_STRATEGIES),
  maxAttempts: z.number().int().min(1).max(50),
  baseDelayMs: z.number().int().min(0).max(3600_000),
  maxDelayMs: z.number().int().min(0).max(24 * 3600_000),
}).refine((p) => p.maxDelayMs >= p.baseDelayMs, { message: 'maxDelayMs must be >= baseDelayMs' });

export function projectRoutes(db: DB): Router {
  const r = Router();

  r.get('/', h((req, res) => {
    const rows = db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM queues q WHERE q.project_id = p.id) AS queue_count
         FROM projects p WHERE p.org_id = ? ORDER BY p.created_at DESC`,
      )
      .all(req.user!.orgId);
    res.json({ data: rows });
  }));

  r.post('/', validateBody(projectSchema), h((req, res) => {
    const row = db
      .prepare(
        `INSERT INTO projects (id, org_id, name, description, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(newId.project(), req.user!.orgId, req.body.name, req.body.description ?? null, Date.now());
    res.status(201).json(row);
  }));

  r.get('/:projectId', h((req, res) => {
    res.json(getProject(db, req.params.projectId, req.user!.orgId));
  }));

  r.patch('/:projectId', validateBody(projectSchema.partial()), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const row = db
      .prepare(`UPDATE projects SET name = ?, description = ? WHERE id = ? RETURNING *`)
      .get(req.body.name ?? project.name, req.body.description ?? project.description, project.id);
    res.json(row);
  }));

  // Destructive: cascades to queues, jobs, executions, logs. Admin only.
  r.delete('/:projectId', requireRole('admin'), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(project.id);
    res.status(204).end();
  }));

  // ---- Metrics ----

  r.get('/:projectId/overview', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    res.json(projectOverview(db, project.id));
  }));

  r.get('/:projectId/throughput', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const minutes = Number(req.query.minutes ?? 30) || 30;
    const bucketSeconds = Number(req.query.bucketSeconds ?? 60) || 60;
    res.json({ data: projectThroughput(db, project.id, { minutes, bucketSeconds }) });
  }));

  // ---- Retry policies (project-scoped; system policies have project_id NULL) ----

  r.get('/:projectId/retry-policies', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const rows = db
      .prepare(`SELECT * FROM retry_policies WHERE project_id IS NULL OR project_id = ? ORDER BY project_id IS NULL DESC, name`)
      .all(project.id);
    res.json({ data: rows });
  }));

  r.post('/:projectId/retry-policies', validateBody(retryPolicySchema), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const b = req.body;
    const row = db
      .prepare(
        `INSERT INTO retry_policies (id, project_id, name, strategy, max_attempts, base_delay_ms, max_delay_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(newId.retryPolicy(), project.id, b.name, b.strategy, b.maxAttempts, b.baseDelayMs, b.maxDelayMs, Date.now());
    res.status(201).json(row);
  }));

  r.delete('/:projectId/retry-policies/:policyId', requireRole('admin'), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const changes = db
      .prepare(`DELETE FROM retry_policies WHERE id = ? AND project_id = ?`)
      .run(req.params.policyId, project.id).changes;
    if (changes === 0) throw ApiError.notFound('Retry policy');
    res.status(204).end();
  }));

  // ---- Dead letter queue (project-wide view) ----

  r.get('/:projectId/dlq', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const p = parsePagination(req);
    const includeRequeued = req.query.includeRequeued === 'true';
    const where = `d.queue_id IN (SELECT id FROM queues WHERE project_id = ?)` + (includeRequeued ? '' : ' AND d.requeued_at IS NULL');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM dead_letter_jobs d WHERE ${where}`).get(project.id) as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT d.*, j.type AS job_type, j.payload, q.name AS queue_name
         FROM dead_letter_jobs d JOIN jobs j ON j.id = d.job_id JOIN queues q ON q.id = d.queue_id
         WHERE ${where} ORDER BY d.moved_at DESC LIMIT ? OFFSET ?`,
      )
      .all(project.id, p.limit, p.offset);
    res.json(paginated(rows, total, p));
  }));

  return r;
}
