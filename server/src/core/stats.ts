import type { DB } from '../db/connection.js';

export interface QueueStats {
  queueId: string;
  byStatus: Record<string, number>;
  depth: number;              // jobs waiting to run (queued + due scheduled/retrying)
  running: number;
  completedLastHour: number;
  failedLastHour: number;
  avgDurationMs: number | null;
  oldestWaitingMs: number | null;
}

export function queueStats(db: DB, queueId: string, now: number = Date.now()): QueueStats {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE queue_id = ? GROUP BY status`)
    .all(queueId) as { status: string; n: number }[];
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = r.n;

  const hourAgo = now - 3600_000;
  const exec = db
    .prepare(
      `SELECT
         SUM(CASE WHEN e.status = 'completed' AND e.finished_at >= ? THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN e.status IN ('failed','timed_out','lost') AND e.finished_at >= ? THEN 1 ELSE 0 END) AS failed,
         AVG(CASE WHEN e.status = 'completed' AND e.finished_at >= ? THEN e.duration_ms END) AS avg_ms
       FROM job_executions e JOIN jobs j ON j.id = e.job_id
       WHERE j.queue_id = ?`,
    )
    .get(hourAgo, hourAgo, hourAgo, queueId) as { completed: number | null; failed: number | null; avg_ms: number | null };

  const oldest = db
    .prepare(
      `SELECT MIN(run_at) AS t FROM jobs
       WHERE queue_id = ? AND status IN ('queued','scheduled','retrying') AND run_at <= ?`,
    )
    .get(queueId, now) as { t: number | null };

  const depth =
    (byStatus['queued'] ?? 0) + (byStatus['scheduled'] ?? 0) + (byStatus['retrying'] ?? 0);
  return {
    queueId,
    byStatus,
    depth,
    running: (byStatus['running'] ?? 0) + (byStatus['claimed'] ?? 0),
    completedLastHour: exec.completed ?? 0,
    failedLastHour: exec.failed ?? 0,
    avgDurationMs: exec.avg_ms === null ? null : Math.round(exec.avg_ms),
    oldestWaitingMs: oldest.t === null ? null : now - oldest.t,
  };
}

export interface ThroughputBucket {
  bucketStart: number;
  completed: number;
  failed: number;
}

/** Executions finished per time bucket for a project — powers the dashboard chart. */
export function projectThroughput(
  db: DB,
  projectId: string,
  opts: { minutes?: number; bucketSeconds?: number; now?: number } = {},
): ThroughputBucket[] {
  const now = opts.now ?? Date.now();
  const minutes = Math.min(opts.minutes ?? 30, 24 * 60);
  const bucketMs = Math.max(opts.bucketSeconds ?? 60, 10) * 1000;
  const since = now - minutes * 60_000;

  const rows = db
    .prepare(
      // CAST is required: bound JS numbers arrive as REAL, and REAL division
      // would leave every timestamp in its own "bucket".
      `SELECT CAST(e.finished_at / @bucket AS INTEGER) * @bucket AS bucket_start,
              SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN e.status IN ('failed','timed_out','lost') THEN 1 ELSE 0 END) AS failed
       FROM job_executions e
       JOIN jobs j ON j.id = e.job_id
       JOIN queues q ON q.id = j.queue_id
       WHERE q.project_id = @projectId AND e.finished_at >= @since
       GROUP BY bucket_start ORDER BY bucket_start`,
    )
    .all({ bucket: bucketMs, projectId, since }) as { bucket_start: number; completed: number; failed: number }[];

  // Densify: emit every bucket in range so charts render gaps as zero.
  const byStart = new Map(rows.map((r) => [r.bucket_start, r]));
  const out: ThroughputBucket[] = [];
  for (let t = Math.floor(since / bucketMs) * bucketMs; t <= now; t += bucketMs) {
    const r = byStart.get(t);
    out.push({ bucketStart: t, completed: r?.completed ?? 0, failed: r?.failed ?? 0 });
  }
  return out;
}

export interface ProjectOverview {
  totals: Record<string, number>;
  queues: { id: string; name: string; is_paused: number; priority: number; concurrency_limit: number; depth: number; running: number; dead: number }[];
  workers: { online: number; total: number };
  dlqSize: number;
  completedLastHour: number;
  failedLastHour: number;
}

export function projectOverview(db: DB, projectId: string, now: number = Date.now()): ProjectOverview {
  const totalsRows = db
    .prepare(
      `SELECT j.status, COUNT(*) AS n FROM jobs j JOIN queues q ON q.id = j.queue_id
       WHERE q.project_id = ? GROUP BY j.status`,
    )
    .all(projectId) as { status: string; n: number }[];
  const totals: Record<string, number> = {};
  for (const r of totalsRows) totals[r.status] = r.n;

  const queues = db
    .prepare(
      `SELECT q.id, q.name, q.is_paused, q.priority, q.concurrency_limit,
              SUM(CASE WHEN j.status IN ('queued','scheduled','retrying') THEN 1 ELSE 0 END) AS depth,
              SUM(CASE WHEN j.status IN ('claimed','running') THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN j.status = 'dead' THEN 1 ELSE 0 END) AS dead
       FROM queues q LEFT JOIN jobs j ON j.queue_id = q.id
       WHERE q.project_id = ? GROUP BY q.id ORDER BY q.priority DESC, q.name`,
    )
    .all(projectId) as ProjectOverview['queues'];

  const workers = db
    .prepare(`SELECT SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online, COUNT(*) AS total FROM workers`)
    .get() as { online: number | null; total: number };

  const dlq = db
    .prepare(`SELECT COUNT(*) AS n FROM dead_letter_jobs d WHERE d.queue_id IN (SELECT id FROM queues WHERE project_id = ?) AND d.requeued_at IS NULL`)
    .get(projectId) as { n: number };

  const hourAgo = now - 3600_000;
  const exec = db
    .prepare(
      `SELECT SUM(CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN e.status IN ('failed','timed_out','lost') THEN 1 ELSE 0 END) AS bad
       FROM job_executions e JOIN jobs j ON j.id = e.job_id JOIN queues q ON q.id = j.queue_id
       WHERE q.project_id = ? AND e.finished_at >= ?`,
    )
    .get(projectId, hourAgo) as { ok: number | null; bad: number | null };

  return {
    totals,
    queues: queues.map((q) => ({ ...q, depth: q.depth ?? 0, running: q.running ?? 0, dead: q.dead ?? 0 })),
    workers: { online: workers.online ?? 0, total: workers.total },
    dlqSize: dlq.n,
    completedLastHour: exec.ok ?? 0,
    failedLastHour: exec.bad ?? 0,
  };
}
