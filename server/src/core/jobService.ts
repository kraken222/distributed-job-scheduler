import type { DB } from '../db/connection.js';
import type { DeadLetterRow, JobRow } from '../types.js';
import { newId } from './ids.js';
import { appendJobLog, skipDependents } from './claims.js';
import { shardFor } from './shard.js';

/** Raised for invalid dependency graphs; routes map it to a 400. */
export class DependencyError extends Error {}

export interface CreateJobInput {
  type: string;
  payload?: unknown;
  priority?: number;
  /** Run after this many ms (delayed job). */
  delayMs?: number;
  /** Absolute epoch-ms run time (scheduled job). Wins over delayMs. */
  runAt?: number;
  timeoutMs?: number;
  retryPolicyId?: string | null;
  idempotencyKey?: string | null;
  batchId?: string | null;
  scheduledJobId?: string | null;
  /** Ids of jobs that must complete before this one becomes claimable. */
  dependsOn?: string[];
  /** Jobs sharing a shard key land on the same shard of a sharded queue. */
  shardKey?: string | null;
}

export interface CreateJobResult {
  job: JobRow;
  /** True when an idempotency key matched an existing job and no new job was created. */
  deduplicated: boolean;
}

export function createJob(db: DB, queueId: string, input: CreateJobInput, now: number = Date.now()): CreateJobResult {
  const runAt = input.runAt ?? now + (input.delayMs ?? 0);
  const status = runAt > now ? 'scheduled' : 'queued';
  const id = newId.job();

  const tx = db.transaction((): CreateJobResult => {
    if (input.idempotencyKey) {
      const existing = db
        .prepare(`SELECT * FROM jobs WHERE queue_id = ? AND idempotency_key = ?`)
        .get(queueId, input.idempotencyKey) as JobRow | undefined;
      if (existing) return { job: existing, deduplicated: true };
    }

    // Dependencies are resolved inside the claim transaction's write lock,
    // so a parent cannot complete between the read and the insert.
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    let pendingDeps = 0;
    if (dependsOn.length > 0) {
      const parents = db
        .prepare(`SELECT id, status FROM jobs WHERE id IN (${dependsOn.map(() => '?').join(',')})`)
        .all(...dependsOn) as { id: string; status: string }[];
      if (parents.length !== dependsOn.length) {
        const found = new Set(parents.map((p) => p.id));
        throw new DependencyError(`Unknown dependency job: ${dependsOn.find((d) => !found.has(d))}`);
      }
      const failed = parents.find((p) => p.status === 'dead' || p.status === 'canceled');
      if (failed) throw new DependencyError(`Cannot depend on ${failed.status} job ${failed.id}`);
      pendingDeps = parents.filter((p) => p.status !== 'completed').length;
    }

    // Sharded queues place the job by shard key (or its own id when keyless).
    const { shard_count } = db.prepare(`SELECT shard_count FROM queues WHERE id = ?`).get(queueId) as {
      shard_count: number;
    };
    const shardKey = input.shardKey ?? null;
    const shard = shardFor(shardKey ?? id, shard_count);

    const job = db
      .prepare(
        `INSERT INTO jobs (id, queue_id, type, payload, status, priority, run_at, retry_policy_id,
                           idempotency_key, batch_id, scheduled_job_id, timeout_ms,
                           shard, shard_key, pending_deps, created_at, updated_at)
         VALUES (@id, @queue_id, @type, @payload, @status, @priority, @run_at, @retry_policy_id,
                 @idempotency_key, @batch_id, @scheduled_job_id, @timeout_ms,
                 @shard, @shard_key, @pending_deps, @now, @now)
         RETURNING *`,
      )
      .get({
        id,
        queue_id: queueId,
        type: input.type,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
        status,
        priority: input.priority ?? 0,
        run_at: runAt,
        retry_policy_id: input.retryPolicyId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        batch_id: input.batchId ?? null,
        scheduled_job_id: input.scheduledJobId ?? null,
        timeout_ms: input.timeoutMs ?? 60000,
        shard,
        shard_key: shardKey,
        pending_deps: pendingDeps,
        now,
      }) as JobRow;

    if (dependsOn.length > 0) {
      const insertDep = db.prepare(
        `INSERT INTO job_dependencies (job_id, depends_on, created_at) VALUES (?, ?, ?)`,
      );
      for (const parentId of dependsOn) insertDep.run(id, parentId, now);
    }
    return { job, deduplicated: false };
  });
  return tx.immediate();
}

export function createBatch(
  db: DB,
  queueId: string,
  args: { name?: string; jobs: CreateJobInput[] },
  now: number = Date.now(),
): { batchId: string; jobs: JobRow[] } {
  const tx = db.transaction(() => {
    const batchId = newId.batch();
    db.prepare(`INSERT INTO batches (id, queue_id, name, total, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      batchId,
      queueId,
      args.name ?? null,
      args.jobs.length,
      now,
    );
    const jobs = args.jobs.map((j) => createJob(db, queueId, { ...j, batchId }, now).job);
    return { batchId, jobs };
  });
  return tx.immediate();
}

export interface WorkflowJobInput extends CreateJobInput {
  /** Local name unique within the workflow; dependsOn refers to these keys. */
  key: string;
  dependsOn?: string[];
}

/**
 * Create a DAG of dependent jobs in one transaction. `dependsOn` refers to
 * sibling keys; jobs are created in topological order so parent ids exist
 * when children reference them. Cycles are rejected up front (Kahn's
 * algorithm), so a workflow can never deadlock waiting on itself.
 */
export function createWorkflow(
  db: DB,
  queueId: string,
  args: { name?: string; jobs: WorkflowJobInput[] },
  now: number = Date.now(),
): { batchId: string; jobs: Record<string, JobRow> } {
  const keys = args.jobs.map((j) => j.key);
  if (new Set(keys).size !== keys.length) throw new DependencyError('Workflow job keys must be unique');
  const byKey = new Map(args.jobs.map((j) => [j.key, j]));
  for (const j of args.jobs) {
    for (const dep of j.dependsOn ?? []) {
      if (!byKey.has(dep)) throw new DependencyError(`Job '${j.key}' depends on unknown key '${dep}'`);
      if (dep === j.key) throw new DependencyError(`Job '${j.key}' cannot depend on itself`);
    }
  }

  // Kahn's algorithm: repeatedly emit nodes whose parents are all emitted.
  const indegree = new Map(keys.map((k) => [k, byKey.get(k)!.dependsOn?.length ?? 0]));
  const children = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const j of args.jobs) for (const dep of j.dependsOn ?? []) children.get(dep)!.push(j.key);
  const order: string[] = keys.filter((k) => indegree.get(k) === 0);
  for (let i = 0; i < order.length; i++) {
    for (const child of children.get(order[i])!) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) order.push(child);
    }
  }
  if (order.length !== keys.length) {
    const cyclic = keys.filter((k) => indegree.get(k)! > 0);
    throw new DependencyError(`Workflow contains a dependency cycle involving: ${cyclic.join(', ')}`);
  }

  const tx = db.transaction(() => {
    const batchId = newId.batch();
    db.prepare(`INSERT INTO batches (id, queue_id, name, total, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      batchId,
      queueId,
      args.name ?? null,
      args.jobs.length,
      now,
    );
    const created: Record<string, JobRow> = {};
    for (const key of order) {
      const spec = byKey.get(key)!;
      created[key] = createJob(
        db,
        queueId,
        { ...spec, batchId, dependsOn: (spec.dependsOn ?? []).map((dep) => created[dep].id) },
        now,
      ).job;
    }
    return { batchId, jobs: created };
  });
  return tx.immediate();
}

/** Cancel a job that has not started executing. Running jobs cannot be interrupted (documented trade-off). */
export function cancelJob(db: DB, jobId: string, now: number = Date.now()): JobRow | null {
  const tx = db.transaction((): JobRow | null => {
    const job = db
      .prepare(
        `UPDATE jobs
         SET status = 'canceled', completed_at = ?, claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('scheduled','queued','retrying')
         RETURNING *`,
      )
      .get(now, now, jobId) as JobRow | undefined;
    if (!job) return null;
    appendJobLog(db, { jobId, level: 'warn', message: 'Job canceled by user', now });
    // Dependents can never run once a parent is canceled.
    skipDependents(db, jobId, `dependency ${jobId} was canceled`, now);
    return job;
  });
  return tx.immediate();
}

/**
 * Manual retry: re-queue a terminally failed (or canceled) job with a fresh
 * attempt budget. Reuses the job row so execution history stays attached.
 */
export function retryJobNow(db: DB, jobId: string, actor: string, now: number = Date.now()): JobRow | null {
  const tx = db.transaction((): JobRow | null => {
    const job = db
      .prepare(
        `UPDATE jobs
         SET status = 'queued', run_at = ?, attempts = 0, completed_at = NULL,
             claimed_by = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('dead','canceled','completed')
         RETURNING *`,
      )
      .get(now, now, jobId) as JobRow | undefined;
    if (!job) {
      // A job waiting on backoff can be nudged to run immediately instead.
      const nudged = db
        .prepare(`UPDATE jobs SET run_at = ?, updated_at = ? WHERE id = ? AND status = 'retrying' RETURNING *`)
        .get(now, now, jobId) as JobRow | undefined;
      if (nudged) appendJobLog(db, { jobId, message: `Retry fast-forwarded by ${actor}`, now });
      return nudged ?? null;
    }
    db.prepare(`UPDATE dead_letter_jobs SET requeued_at = ?, requeued_job_id = ? WHERE job_id = ? AND requeued_at IS NULL`).run(
      now,
      jobId,
      jobId,
    );
    appendJobLog(db, { jobId, message: `Manually re-queued by ${actor}`, now });
    return job;
  });
  return tx.immediate();
}

export function requeueDeadLetter(db: DB, dlqId: string, actor: string, now: number = Date.now()): JobRow | null {
  const entry = db.prepare(`SELECT * FROM dead_letter_jobs WHERE id = ?`).get(dlqId) as DeadLetterRow | undefined;
  if (!entry || entry.requeued_at !== null) return null;
  return retryJobNow(db, entry.job_id, actor, now);
}
