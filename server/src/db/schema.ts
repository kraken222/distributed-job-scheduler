import type { DB } from './connection.js';

/**
 * Versioned, forward-only migrations. Each entry runs in a transaction and
 * bumps PRAGMA user_version, so restarting any process is idempotent and a
 * fleet of workers can share one database file safely.
 */
const migrations: string[] = [
  /* ---- v1: full initial schema ---- */ `
  CREATE TABLE organizations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_users_org ON users(org_id);

  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (org_id, name)
  );
  CREATE INDEX idx_projects_org ON projects(org_id);

  CREATE TABLE retry_policies (
    id            TEXT PRIMARY KEY,
    -- NULL project_id = built-in system policy visible to every project
    project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    strategy      TEXT NOT NULL CHECK (strategy IN ('fixed','linear','exponential')),
    max_attempts  INTEGER NOT NULL CHECK (max_attempts >= 1),
    base_delay_ms INTEGER NOT NULL CHECK (base_delay_ms >= 0),
    max_delay_ms  INTEGER NOT NULL CHECK (max_delay_ms >= base_delay_ms),
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_retry_policies_project ON retry_policies(project_id);

  CREATE TABLE queues (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    -- Higher priority queues are drained first when workers claim.
    priority          INTEGER NOT NULL DEFAULT 0,
    -- Max jobs from this queue running at once across the whole fleet.
    concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK (concurrency_limit >= 1),
    is_paused         INTEGER NOT NULL DEFAULT 0,
    retry_policy_id   TEXT REFERENCES retry_policies(id) ON DELETE SET NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (project_id, name)
  );
  CREATE INDEX idx_queues_project ON queues(project_id);

  CREATE TABLE workers (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    hostname          TEXT NOT NULL,
    pid               INTEGER NOT NULL,
    concurrency       INTEGER NOT NULL,
    status            TEXT NOT NULL DEFAULT 'online'
                      CHECK (status IN ('online','draining','offline','lost')),
    started_at        INTEGER NOT NULL,
    last_heartbeat_at INTEGER NOT NULL,
    stopped_at        INTEGER
  );
  CREATE INDEX idx_workers_heartbeat ON workers(status, last_heartbeat_at);

  CREATE TABLE worker_heartbeats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id    TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
    at           INTEGER NOT NULL,
    active_jobs  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_heartbeats_worker ON worker_heartbeats(worker_id, at);

  CREATE TABLE batches (
    id         TEXT PRIMARY KEY,
    queue_id   TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    name       TEXT,
    total      INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE scheduled_jobs (
    id              TEXT PRIMARY KEY,
    queue_id        TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    cron            TEXT NOT NULL,
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    job_type        TEXT NOT NULL,
    payload         TEXT,
    priority        INTEGER NOT NULL DEFAULT 0,
    timeout_ms      INTEGER NOT NULL DEFAULT 60000,
    retry_policy_id TEXT REFERENCES retry_policies(id) ON DELETE SET NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    next_run_at     INTEGER NOT NULL,
    last_run_at     INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  -- The cron scheduler scans "enabled AND next_run_at <= now" every tick.
  CREATE INDEX idx_schedules_due ON scheduled_jobs(enabled, next_run_at);

  CREATE TABLE jobs (
    id               TEXT PRIMARY KEY,
    queue_id         TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    type             TEXT NOT NULL,
    payload          TEXT,
    status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                     ('scheduled','queued','claimed','running','retrying',
                      'completed','dead','canceled')),
    priority         INTEGER NOT NULL DEFAULT 0,
    run_at           INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    retry_policy_id  TEXT REFERENCES retry_policies(id) ON DELETE SET NULL,
    idempotency_key  TEXT,
    batch_id         TEXT REFERENCES batches(id) ON DELETE SET NULL,
    scheduled_job_id TEXT REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
    timeout_ms       INTEGER NOT NULL DEFAULT 60000,
    claimed_by       TEXT REFERENCES workers(id) ON DELETE SET NULL,
    lease_expires_at INTEGER,
    started_at       INTEGER,
    completed_at     INTEGER,
    last_error       TEXT,
    result           TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  -- The hot path: workers claim by (status, run_at) within a queue, ordered
  -- by priority. This composite index covers the claim scan.
  CREATE INDEX idx_jobs_claim ON jobs(queue_id, status, run_at, priority);
  CREATE INDEX idx_jobs_status ON jobs(status, run_at);
  CREATE INDEX idx_jobs_batch ON jobs(batch_id) WHERE batch_id IS NOT NULL;
  CREATE INDEX idx_jobs_worker ON jobs(claimed_by) WHERE claimed_by IS NOT NULL;
  CREATE INDEX idx_jobs_list ON jobs(queue_id, created_at DESC);
  -- Idempotent job creation: one logical job per (queue, key).
  CREATE UNIQUE INDEX idx_jobs_idempotency ON jobs(queue_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE TABLE job_executions (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id   TEXT NOT NULL,
    attempt     INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN
                ('running','completed','failed','timed_out','lost')),
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    error       TEXT,
    result      TEXT
  );
  CREATE INDEX idx_executions_job ON job_executions(job_id, attempt);
  -- Throughput metrics bucket executions by finish time.
  CREATE INDEX idx_executions_finished ON job_executions(finished_at)
    WHERE finished_at IS NOT NULL;

  CREATE TABLE job_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    execution_id TEXT REFERENCES job_executions(id) ON DELETE CASCADE,
    level        TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
    message      TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_logs_job ON job_logs(job_id, id);

  CREATE TABLE dead_letter_jobs (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    queue_id        TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,
    attempts        INTEGER NOT NULL,
    moved_at        INTEGER NOT NULL,
    requeued_at     INTEGER,
    requeued_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_dlq_queue ON dead_letter_jobs(queue_id, moved_at DESC);
  `,

  /* ---- v2: workflow dependencies, rate limiting, sharding, events, failure summaries ---- */ `
  -- Rate limiting: at most rate_limit_max execution *starts* per sliding
  -- rate_limit_window_ms window, enforced fleet-wide in the claim transaction.
  -- NULL = unlimited.
  ALTER TABLE queues ADD COLUMN rate_limit_max INTEGER
    CHECK (rate_limit_max IS NULL OR rate_limit_max >= 1);
  ALTER TABLE queues ADD COLUMN rate_limit_window_ms INTEGER
    CHECK (rate_limit_window_ms IS NULL OR rate_limit_window_ms >= 100);

  -- Sharding: jobs hash (by shard_key, else job id) onto [0, shard_count).
  -- Workers may pin themselves to a shard subset via WORKER_SHARDS.
  ALTER TABLE queues ADD COLUMN shard_count INTEGER NOT NULL DEFAULT 1
    CHECK (shard_count >= 1);
  ALTER TABLE jobs ADD COLUMN shard INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN shard_key TEXT;

  -- Workflow dependencies: denormalized count of incomplete parents. The
  -- claim query gates on pending_deps = 0; completeJob decrements children.
  ALTER TABLE jobs ADD COLUMN pending_deps INTEGER NOT NULL DEFAULT 0
    CHECK (pending_deps >= 0);

  CREATE TABLE job_dependencies (
    job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    depends_on TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, depends_on)
  ) WITHOUT ROWID;
  -- Parent -> children lookup: completion fan-out and failure cascade.
  CREATE INDEX idx_deps_parent ON job_dependencies(depends_on);

  -- AI/heuristic failure summaries, filled in asynchronously by the API
  -- process after a job dead-letters.
  ALTER TABLE dead_letter_jobs ADD COLUMN summary TEXT;
  ALTER TABLE dead_letter_jobs ADD COLUMN summary_source TEXT
    CHECK (summary_source IS NULL OR summary_source IN ('ai','heuristic'));

  -- Event-driven execution: emitted events fan out to jobs via triggers.
  CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    payload      TEXT,
    jobs_created INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_events_project ON events(project_id, created_at DESC);

  CREATE TABLE event_triggers (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue_id   TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL,
    job_type   TEXT NOT NULL,
    payload    TEXT,
    priority   INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Emit path: find enabled triggers for (project, event name).
  CREATE INDEX idx_triggers_lookup ON event_triggers(project_id, event_name, enabled);

  -- Rate limiter counts execution starts inside the window.
  CREATE INDEX idx_executions_started ON job_executions(started_at);
  `,
];

/** Built-in retry policies inserted once; queues without an explicit policy fall back to "default". */
const SYSTEM_POLICIES = [
  { id: 'rp_default', name: 'default', strategy: 'exponential', max_attempts: 3, base_delay_ms: 1000, max_delay_ms: 60000 },
  { id: 'rp_none', name: 'no-retry', strategy: 'fixed', max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0 },
  { id: 'rp_aggressive', name: 'aggressive', strategy: 'exponential', max_attempts: 8, base_delay_ms: 500, max_delay_ms: 300000 },
];

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO retry_policies
       (id, project_id, name, strategy, max_attempts, base_delay_ms, max_delay_ms, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of SYSTEM_POLICIES) {
    insert.run(p.id, p.name, p.strategy, p.max_attempts, p.base_delay_ms, p.max_delay_ms, Date.now());
  }
}

export const DEFAULT_RETRY_POLICY_ID = 'rp_default';
