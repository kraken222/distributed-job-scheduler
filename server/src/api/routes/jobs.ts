import { Router } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/connection.js';
import { cancelJob, requeueDeadLetter, retryJobNow } from '../../core/jobService.js';
import { assertValidCron, nextCronRun } from '../../core/cron.js';
import { getJob, getSchedule } from '../access.js';
import { ApiError, h, paginated, parsePagination, parseJson } from '../http.js';
import { validateBody } from '../middleware.js';

const scheduleUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cron: z.string().min(1).max(100).optional(),
  timezone: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  payload: z.unknown().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  timeoutMs: z.number().int().min(100).max(3600_000).optional(),
});

export function jobRoutes(db: DB): Router {
  const r = Router();

  r.get('/jobs/:jobId', h((req, res) => {
    const job = getJob(db, req.params.jobId, req.user!.orgId);
    res.json({ ...job, payload: parseJson(job.payload), result: parseJson(job.result) });
  }));

  r.post('/jobs/:jobId/cancel', h((req, res) => {
    const job = getJob(db, req.params.jobId, req.user!.orgId);
    const canceled = cancelJob(db, job.id);
    if (!canceled) throw ApiError.conflict(`Cannot cancel a job in status '${job.status}'`);
    res.json(canceled);
  }));

  r.post('/jobs/:jobId/retry', h((req, res) => {
    const job = getJob(db, req.params.jobId, req.user!.orgId);
    const retried = retryJobNow(db, job.id, req.user!.email);
    if (!retried) throw ApiError.conflict(`Cannot retry a job in status '${job.status}'`);
    res.json(retried);
  }));

  r.get('/jobs/:jobId/executions', h((req, res) => {
    const job = getJob(db, req.params.jobId, req.user!.orgId);
    const rows = db
      .prepare(
        `SELECT e.*, w.name AS worker_name FROM job_executions e
         LEFT JOIN workers w ON w.id = e.worker_id
         WHERE e.job_id = ? ORDER BY e.attempt ASC`,
      )
      .all(job.id) as { result: string | null }[];
    res.json({ data: rows.map((e) => ({ ...e, result: parseJson(e.result) })) });
  }));

  r.get('/jobs/:jobId/logs', h((req, res) => {
    const job = getJob(db, req.params.jobId, req.user!.orgId);
    const rows = db.prepare(`SELECT * FROM job_logs WHERE job_id = ? ORDER BY id ASC LIMIT 1000`).all(job.id);
    res.json({ data: rows });
  }));

  // Workflow neighbourhood: what this job waits on, and what waits on it.
  r.get('/jobs/:jobId/dependencies', h((req, res) => {
    const job = getJob(db, req.params.jobId, req.user!.orgId);
    const parents = db
      .prepare(
        `SELECT j.id, j.type, j.status FROM job_dependencies d JOIN jobs j ON j.id = d.depends_on
         WHERE d.job_id = ? ORDER BY j.created_at`,
      )
      .all(job.id);
    const children = db
      .prepare(
        `SELECT j.id, j.type, j.status FROM job_dependencies d JOIN jobs j ON j.id = d.job_id
         WHERE d.depends_on = ? ORDER BY j.created_at`,
      )
      .all(job.id);
    res.json({ parents, children, pendingDeps: job.pending_deps });
  }));

  // ---- Workers (deployment-wide; read-only observability) ----

  r.get('/workers', h((req, res) => {
    const p = parsePagination(req);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM workers`).get() as { n: number }).n;
    const rows = db
      .prepare(
        `SELECT w.*,
                (SELECT COUNT(*) FROM jobs j WHERE j.claimed_by = w.id AND j.status IN ('claimed','running')) AS active_jobs,
                (SELECT COUNT(*) FROM job_executions e WHERE e.worker_id = w.id AND e.status = 'completed') AS completed_total,
                (SELECT COUNT(*) FROM job_executions e WHERE e.worker_id = w.id AND e.status IN ('failed','timed_out','lost')) AS failed_total
         FROM workers w
         ORDER BY (w.status = 'online') DESC, w.last_heartbeat_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(p.limit, p.offset);
    res.json(paginated(rows, total, p));
  }));

  r.get('/workers/:workerId/heartbeats', h((req, res) => {
    const rows = db
      .prepare(`SELECT at, active_jobs FROM worker_heartbeats WHERE worker_id = ? ORDER BY at DESC LIMIT 50`)
      .all(req.params.workerId);
    res.json({ data: rows });
  }));

  // ---- DLQ requeue ----

  r.post('/dlq/:dlqId/requeue', h((req, res) => {
    // Tenancy: ensure the DLQ entry's job belongs to the caller's org.
    const entry = db
      .prepare(
        `SELECT d.id, d.job_id FROM dead_letter_jobs d
         JOIN queues q ON q.id = d.queue_id JOIN projects p ON p.id = q.project_id
         WHERE d.id = ? AND p.org_id = ?`,
      )
      .get(req.params.dlqId, req.user!.orgId) as { id: string } | undefined;
    if (!entry) throw ApiError.notFound('Dead letter entry');
    const job = requeueDeadLetter(db, entry.id, req.user!.email);
    if (!job) throw ApiError.conflict('Entry was already requeued');
    res.json(job);
  }));

  // ---- Schedule mutations ----

  r.patch('/schedules/:scheduleId', validateBody(scheduleUpdateSchema), h((req, res) => {
    const s = getSchedule(db, req.params.scheduleId, req.user!.orgId);
    const b = req.body;
    const cron = b.cron ?? s.cron;
    const timezone = b.timezone ?? s.timezone;
    if (b.cron !== undefined || b.timezone !== undefined) {
      try {
        assertValidCron(cron, timezone);
      } catch (err) {
        throw ApiError.badRequest((err as Error).message);
      }
    }
    const now = Date.now();
    const row = db
      .prepare(
        `UPDATE scheduled_jobs
         SET name = ?, cron = ?, timezone = ?, enabled = ?, payload = ?, priority = ?, timeout_ms = ?,
             next_run_at = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        b.name ?? s.name, cron, timezone,
        b.enabled === undefined ? s.enabled : b.enabled ? 1 : 0,
        b.payload === undefined ? s.payload : JSON.stringify(b.payload),
        b.priority ?? s.priority, b.timeoutMs ?? s.timeout_ms,
        // Recompute the next firing when the cadence changes.
        b.cron !== undefined || b.timezone !== undefined ? nextCronRun(cron, timezone, now) : s.next_run_at,
        now, s.id,
      );
    res.json(row);
  }));

  r.delete('/schedules/:scheduleId', h((req, res) => {
    const s = getSchedule(db, req.params.scheduleId, req.user!.orgId);
    db.prepare(`DELETE FROM scheduled_jobs WHERE id = ?`).run(s.id);
    res.status(204).end();
  }));

  return r;
}
