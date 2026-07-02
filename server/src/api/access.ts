import type { DB } from '../db/connection.js';
import type { JobRow, QueueRow, ScheduledJobRow } from '../types.js';
import { ApiError } from './http.js';

/**
 * Tenancy guards. Every resource lookup is joined back to the caller's
 * organization, so a valid token from org A can never read or mutate org
 * B's data — cross-org access is indistinguishable from "not found".
 */

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_at: number;
}

export function getProject(db: DB, projectId: string, orgId: string): ProjectRow {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ? AND org_id = ?`).get(projectId, orgId) as
    | ProjectRow
    | undefined;
  if (!row) throw ApiError.notFound('Project');
  return row;
}

export function getQueue(db: DB, queueId: string, orgId: string): QueueRow {
  const row = db
    .prepare(
      `SELECT q.* FROM queues q JOIN projects p ON p.id = q.project_id
       WHERE q.id = ? AND p.org_id = ?`,
    )
    .get(queueId, orgId) as QueueRow | undefined;
  if (!row) throw ApiError.notFound('Queue');
  return row;
}

export function getJob(db: DB, jobId: string, orgId: string): JobRow & { queue_name: string; project_id: string } {
  const row = db
    .prepare(
      `SELECT j.*, q.name AS queue_name, q.project_id
       FROM jobs j JOIN queues q ON q.id = j.queue_id JOIN projects p ON p.id = q.project_id
       WHERE j.id = ? AND p.org_id = ?`,
    )
    .get(jobId, orgId) as (JobRow & { queue_name: string; project_id: string }) | undefined;
  if (!row) throw ApiError.notFound('Job');
  return row;
}

export function getSchedule(db: DB, scheduleId: string, orgId: string): ScheduledJobRow {
  const row = db
    .prepare(
      `SELECT s.* FROM scheduled_jobs s
       JOIN queues q ON q.id = s.queue_id JOIN projects p ON p.id = q.project_id
       WHERE s.id = ? AND p.org_id = ?`,
    )
    .get(scheduleId, orgId) as ScheduledJobRow | undefined;
  if (!row) throw ApiError.notFound('Schedule');
  return row;
}

/** Retry policies: system policies (project_id NULL) or ones owned by the caller's org. */
export function getRetryPolicy(db: DB, policyId: string, orgId: string) {
  const row = db
    .prepare(
      `SELECT rp.* FROM retry_policies rp
       LEFT JOIN projects p ON p.id = rp.project_id
       WHERE rp.id = ? AND (rp.project_id IS NULL OR p.org_id = ?)`,
    )
    .get(policyId, orgId);
  if (!row) throw ApiError.notFound('Retry policy');
  return row;
}
