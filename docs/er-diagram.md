# Database design

Schema lives in [`server/src/db/schema.ts`](../server/src/db/schema.ts) as versioned,
forward-only migrations (`PRAGMA user_version`), applied idempotently by every process at
startup. All timestamps are Unix epoch **milliseconds** (`INTEGER`) — cheap to index,
compare and bucket; no timezone ambiguity.

## ER diagram

```mermaid
erDiagram
    organizations ||--o{ users : "has"
    organizations ||--o{ projects : "owns"
    projects ||--o{ queues : "owns"
    projects ||--o{ retry_policies : "defines (NULL = system)"
    retry_policies |o--o{ queues : "default policy"
    retry_policies |o--o{ jobs : "override"
    queues ||--o{ jobs : "contains"
    queues ||--o{ scheduled_jobs : "cron schedules"
    queues ||--o{ batches : "groups"
    batches |o--o{ jobs : "batch member"
    scheduled_jobs |o--o{ jobs : "materialized firing"
    jobs ||--o{ job_executions : "attempts"
    jobs ||--o{ job_logs : "log lines"
    jobs ||--o| dead_letter_jobs : "on permanent failure"
    jobs ||--o{ job_dependencies : "waits on / unblocks"
    projects ||--o{ events : "emitted"
    projects ||--o{ event_triggers : "subscriptions"
    queues ||--o{ event_triggers : "fan-out target"
    workers ||--o{ job_executions : "ran"
    workers ||--o{ worker_heartbeats : "liveness"
    workers |o--o{ jobs : "current claim"

    organizations { text id PK; text name }
    users { text id PK; text org_id FK; text email UK; text password_hash; text role }
    projects { text id PK; text org_id FK; text name; text description }
    retry_policies { text id PK; text project_id FK "NULL=system"; text strategy; int max_attempts; int base_delay_ms; int max_delay_ms }
    queues { text id PK; text project_id FK; text name; int priority; int concurrency_limit; int is_paused; text retry_policy_id FK; int rate_limit_max "NULL=unlimited"; int rate_limit_window_ms; int shard_count }
    jobs { text id PK; text queue_id FK; text type; text payload; text status; int priority; int run_at; int attempts; text idempotency_key; text batch_id FK; text scheduled_job_id FK; int timeout_ms; text claimed_by FK; int lease_expires_at; text last_error; text result; int shard; text shard_key; int pending_deps }
    job_dependencies { text job_id PK_FK; text depends_on PK_FK; int created_at }
    job_executions { text id PK; text job_id FK; text worker_id; int attempt; text status; int started_at; int finished_at; int duration_ms; text error; text result }
    job_logs { int id PK; text job_id FK; text execution_id FK; text level; text message; int created_at }
    scheduled_jobs { text id PK; text queue_id FK; text name; text cron; text timezone; text job_type; text payload; int enabled; int next_run_at; int last_run_at }
    batches { text id PK; text queue_id FK; text name; int total }
    events { text id PK; text project_id FK; text name; text payload; int jobs_created; int created_at }
    event_triggers { text id PK; text project_id FK; text queue_id FK; text event_name; text job_type; text payload; int priority; int enabled }
    workers { text id PK; text name; text hostname; int pid; int concurrency; text status; int started_at; int last_heartbeat_at }
    worker_heartbeats { int id PK; text worker_id FK; int at; int active_jobs }
    dead_letter_jobs { text id PK; text job_id FK; text queue_id FK; text reason; int attempts; int moved_at; int requeued_at; text requeued_job_id FK; text summary; text summary_source }
```

## Keys

- **Primary keys** are prefixed random text IDs (`job_…`, `que_…`, nanoid, 20 chars).
  Prefixes make every ID self-describing in logs and API payloads; random IDs avoid
  cross-tenant enumeration and merge safely if shards are ever consolidated.
  `job_logs` / `worker_heartbeats` use `INTEGER AUTOINCREMENT` instead — they are
  high-volume append-only rows where insertion order *is* the natural order and rowid
  keys keep them compact.
- **Foreign keys** are enforced (`PRAGMA foreign_keys = ON`).

## Cascading behaviour (deliberate, per relation)

| Relation | On delete | Why |
|---|---|---|
| org → users/projects, project → queues/events/triggers, queue → jobs/schedules/batches/triggers, job → executions/logs/dependencies | `CASCADE` | tenant data forms a strict ownership tree; deleting a parent must not leave orphans |
| queue/job → retry_policy | `SET NULL` | deleting a policy must not delete jobs; they fall back to the system default at resolution time |
| job → batch, job → scheduled_job | `SET NULL` | history metadata, not ownership |
| jobs.claimed_by → workers | `SET NULL` | a deregistered worker must never take jobs down with it |
| job_dependencies (both edges) | `CASCADE` | an edge is meaningless once either endpoint is gone; the `pending_deps` counter on live children is untouched by parent-row deletion because deleting jobs is not part of the lifecycle (jobs terminate, they aren't deleted) |

## Normalization

The schema is in 3NF where it matters: retry policies are a referenced entity (not columns
copied onto every job), queue configuration lives only on `queues`, execution outcomes live
only on `job_executions`. Two deliberate denormalizations:

- `jobs.attempts` / `jobs.last_error` / `jobs.status` duplicate information derivable from
  `job_executions` — but the claim query and the dashboard hit these on every poll, and
  deriving them would turn the hottest queries into aggregates.
- `dead_letter_jobs.attempts`/`reason` snapshot the failure at burial time so the DLQ view
  needs no joins into execution history.
- `jobs.pending_deps` counts incomplete parents (derivable from `job_dependencies` +
  parent statuses). The claim query gates on `pending_deps = 0` as an indexed integer
  comparison instead of re-walking DAG edges on every worker poll; the counter is
  maintained inside the same transactions that transition parent state, so it cannot drift.
- `events.jobs_created` snapshots fan-out size so the event audit list needs no join.

## Indexes and performance

| Index | Serves |
|---|---|
| `idx_jobs_claim (queue_id, status, run_at, priority)` | the worker claim scan — the hottest query in the system |
| `idx_jobs_status (status, run_at)` | reaper (`claimed/running` with expired lease) and global status counts |
| `idx_jobs_idempotency UNIQUE (queue_id, idempotency_key) WHERE … NOT NULL` | O(log n) dedupe on enqueue; partial so jobs without keys cost nothing |
| `idx_jobs_list (queue_id, created_at DESC)` | job explorer pagination |
| `idx_jobs_batch`, `idx_jobs_worker` (partial) | batch progress, "jobs on this worker" |
| `idx_executions_job (job_id, attempt)` | retry history view |
| `idx_executions_finished (finished_at) WHERE NOT NULL` | throughput bucketing |
| `idx_schedules_due (enabled, next_run_at)` | scheduler tick is a range scan, not a table scan |
| `idx_workers_heartbeat (status, last_heartbeat_at)` | reaper staleness check |
| `idx_dlq_queue (queue_id, moved_at DESC)` | DLQ listing |
| `idx_deps_parent (depends_on)` | completion fan-out ("which children does this parent unblock?") and failure cascade |
| `idx_executions_started (started_at)` | sliding-window rate limit count in the claim transaction |
| `idx_events_project (project_id, created_at DESC)` | event audit listing |
| `idx_triggers_lookup (project_id, event_name, enabled)` | emit-time trigger matching |

Other performance considerations:

- **WAL mode** lets dashboard reads proceed while workers write; `busy_timeout=5000` queues
  writers instead of erroring under contention.
- `worker_heartbeats` is **bounded** (last 100 rows per worker, pruned on write) so liveness
  history can't grow without limit.
- Counting queries used by stats run against indexed columns; the throughput query buckets
  `finished_at` arithmetically (no `strftime`) to stay on the index.
- Unique constraints double as business rules: `UNIQUE(org_id, name)` on projects,
  `UNIQUE(project_id, name)` on queues, `UNIQUE(email)` on users.
