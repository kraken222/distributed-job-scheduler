import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/connection.js';
import { assertValidCron, nextCronRun } from '../../core/cron.js';
import { newId } from '../../core/ids.js';
import { createBatch, createJob } from '../../core/jobService.js';
import { queueStats } from '../../core/stats.js';
import { JOB_STATUSES } from '../../types.js';
import { getProject, getQueue, getRetryPolicy } from '../access.js';
import { ApiError, h, paginated, parsePagination, parseJson } from '../http.js';
import { requireRole, validateBody } from '../middleware.js';

const queueSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/, 'letters, digits, dot, dash, underscore only'),
  priority: z.number().int().min(-100).max(100).default(0),
  concurrencyLimit: z.number().int().min(1).max(1000).default(10),
  retryPolicyId: z.string().nullish(),
});

const jobSchema = z.object({
  type: z.string().min(1).max(200),
  payload: z.unknown().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  delayMs: z.number().int().min(0).max(365 * 24 * 3600_000).optional(),
  runAt: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(100).max(3600_000).optional(),
  retryPolicyId: z.string().nullish(),
  idempotencyKey: z.string().min(1).max(200).nullish(),
});

const batchSchema = z.object({
  name: z.string().max(200).optional(),
  jobs: z.array(jobSchema).min(1).max(1000),
});

const scheduleSchema = z.object({
  name: z.string().min(1).max(200),
  cron: z.string().min(1).max(100),
  timezone: z.string().max(64).default('UTC'),
  jobType: z.string().min(1).max(200),
  payload: z.unknown().optional(),
  priority: z.number().int().min(-100).max(100).default(0),
  timeoutMs: z.number().int().min(100).max(3600_000).default(60000),
  retryPolicyId: z.string().nullish(),
});

export function queueRoutes(db: DB): Router {
  const r = Router();

  // ---- Queue CRUD (nested under project for creation/list) ----

  r.get('/projects/:projectId/queues', h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    const rows = db
      .prepare(`SELECT * FROM queues WHERE project_id = ? ORDER BY priority DESC, name`)
      .all(project.id) as { id: string }[];
    res.json({ data: rows.map((q) => ({ ...q, stats: queueStats(db, q.id) })) });
  }));

  r.post('/projects/:projectId/queues', validateBody(queueSchema), h((req, res) => {
    const project = getProject(db, req.params.projectId, req.user!.orgId);
    if (req.body.retryPolicyId) getRetryPolicy(db, req.body.retryPolicyId, req.user!.orgId);
    const now = Date.now();
    const row = db
      .prepare(
        `INSERT INTO queues (id, project_id, name, priority, concurrency_limit, retry_policy_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(newId.queue(), project.id, req.body.name, req.body.priority, req.body.concurrencyLimit, req.body.retryPolicyId ?? null, now, now);
    res.status(201).json(row);
  }));

  r.get('/queues/:queueId', h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    res.json({ ...queue, stats: queueStats(db, queue.id) });
  }));

  r.patch('/queues/:queueId', validateBody(queueSchema.partial()), h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    if (req.body.retryPolicyId) getRetryPolicy(db, req.body.retryPolicyId, req.user!.orgId);
    const row = db
      .prepare(
        `UPDATE queues SET name = ?, priority = ?, concurrency_limit = ?, retry_policy_id = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        req.body.name ?? queue.name,
        req.body.priority ?? queue.priority,
        req.body.concurrencyLimit ?? queue.concurrency_limit,
        req.body.retryPolicyId === undefined ? queue.retry_policy_id : req.body.retryPolicyId,
        Date.now(),
        queue.id,
      );
    res.json(row);
  }));

  r.delete('/queues/:queueId', requireRole('admin'), h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    db.prepare(`DELETE FROM queues WHERE id = ?`).run(queue.id);
    res.status(204).end();
  }));

  r.post('/queues/:queueId/pause', h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    const row = db.prepare(`UPDATE queues SET is_paused = 1, updated_at = ? WHERE id = ? RETURNING *`).get(Date.now(), queue.id);
    res.json(row);
  }));

  r.post('/queues/:queueId/resume', h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    const row = db.prepare(`UPDATE queues SET is_paused = 0, updated_at = ? WHERE id = ? RETURNING *`).get(Date.now(), queue.id);
    res.json(row);
  }));

  r.get('/queues/:queueId/stats', h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    res.json(queueStats(db, queue.id));
  }));

  // ---- Job creation & listing ----

  r.post('/queues/:queueId/jobs', validateBody(jobSchema), h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    if (req.body.retryPolicyId) getRetryPolicy(db, req.body.retryPolicyId, req.user!.orgId);
    const { job, deduplicated } = createJob(db, queue.id, req.body);
    res.status(deduplicated ? 200 : 201).json({ ...job, payload: parseJson(job.payload), deduplicated });
  }));

  r.post('/queues/:queueId/batches', validateBody(batchSchema), h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    const { batchId, jobs } = createBatch(db, queue.id, req.body);
    res.status(201).json({ batchId, total: jobs.length, jobIds: jobs.map((j) => j.id) });
  }));

  r.get('/queues/:queueId/jobs', h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    const p = parsePagination(req);

    const clauses = ['queue_id = @queueId'];
    const params: Record<string, unknown> = { queueId: queue.id };
    if (req.query.status) {
      const statuses = String(req.query.status).split(',');
      if (statuses.some((s) => !(JOB_STATUSES as readonly string[]).includes(s))) {
        throw ApiError.badRequest(`Invalid status filter; valid values: ${JOB_STATUSES.join(', ')}`);
      }
      clauses.push(`status IN (${statuses.map((_, i) => `@s${i}`).join(',')})`);
      statuses.forEach((s, i) => (params[`s${i}`] = s));
    }
    if (req.query.type) {
      clauses.push(`type = @type`);
      params.type = String(req.query.type);
    }
    if (req.query.batchId) {
      clauses.push(`batch_id = @batchId`);
      params.batchId = String(req.query.batchId);
    }
    if (req.query.search) {
      clauses.push(`(id LIKE @search OR type LIKE @search OR payload LIKE @search)`);
      params.search = `%${String(req.query.search)}%`;
    }
    const where = clauses.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${where}`).get(params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: p.limit, offset: p.offset }) as { payload: string | null; result: string | null }[];
    res.json(paginated(rows.map((j) => ({ ...j, payload: parseJson(j.payload), result: parseJson(j.result) })), total, p));
  }));

  // ---- Recurring (cron) schedules ----

  r.get('/queues/:queueId/schedules', h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    const rows = db.prepare(`SELECT * FROM scheduled_jobs WHERE queue_id = ? ORDER BY name`).all(queue.id);
    res.json({ data: rows });
  }));

  r.post('/queues/:queueId/schedules', validateBody(scheduleSchema), h((req, res) => {
    const queue = getQueue(db, req.params.queueId, req.user!.orgId);
    const b = req.body;
    try {
      assertValidCron(b.cron, b.timezone);
    } catch (err) {
      throw ApiError.badRequest((err as Error).message);
    }
    if (b.retryPolicyId) getRetryPolicy(db, b.retryPolicyId, req.user!.orgId);
    const now = Date.now();
    const row = db
      .prepare(
        `INSERT INTO scheduled_jobs (id, queue_id, name, cron, timezone, job_type, payload, priority,
                                     timeout_ms, retry_policy_id, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING *`,
      )
      .get(
        newId.schedule(), queue.id, b.name, b.cron, b.timezone, b.jobType,
        b.payload === undefined ? null : JSON.stringify(b.payload),
        b.priority, b.timeoutMs, b.retryPolicyId ?? null,
        nextCronRun(b.cron, b.timezone, now), now, now,
      );
    res.status(201).json(row);
  }));

  return r;
}
