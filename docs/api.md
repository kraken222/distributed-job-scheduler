# API reference

Base URL: `http://localhost:4000/api`

## Conventions

- **Auth**: `Authorization: Bearer <jwt>` on everything except `/auth/*` and `/health`.
- **Errors** are always structured:
  ```json
  { "error": { "code": "bad_request", "message": "Validation failed", "details": [{ "path": "type", "message": "Required" }] } }
  ```
  Codes: `bad_request` 400 · `unauthorized` 401 · `forbidden` 403 · `not_found` 404 ·
  `conflict` 409 · `internal` 500. Resources of another organization return **404** (not 403).
- **Pagination**: `?page=1&limit=25` (max 100) →
  `{ "data": [...], "pagination": { "page", "limit", "total", "totalPages" } }`.
- Timestamps are epoch **milliseconds**.
- **RBAC**: the first user of an organization is `admin`. Destructive operations
  (delete project/queue, delete retry policy) require `admin`; everything else needs any
  authenticated member.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ organizationName, name, email, password (≥8) }` | creates org + admin user → `{ token, user }` |
| POST | `/auth/login` | `{ email, password }` | → `{ token, user }`; uniform 401 (no account enumeration) |
| GET | `/auth/me` | — | current user + organization |

## Projects

| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | list (with queue counts) |
| POST | `/projects` | `{ name, description? }` |
| GET/PATCH | `/projects/:id` | |
| DELETE | `/projects/:id` | **admin**; cascades to queues/jobs/history |
| GET | `/projects/:id/overview` | totals by status, per-queue health, workers, DLQ size |
| GET | `/projects/:id/throughput?minutes=30&bucketSeconds=60` | densified buckets `{ bucketStart, completed, failed }` |
| GET | `/projects/:id/dlq?includeRequeued=false` | paginated dead letter entries |
| GET | `/projects/:id/retry-policies` | system + project policies |
| POST | `/projects/:id/retry-policies` | `{ name, strategy: fixed\|linear\|exponential, maxAttempts, baseDelayMs, maxDelayMs }` |
| DELETE | `/projects/:id/retry-policies/:policyId` | **admin**; queues fall back to the system default |

## Queues

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/queues` | each with live stats |
| POST | `/projects/:id/queues` | `{ name, priority?, concurrencyLimit?, retryPolicyId?, rateLimitMax?, rateLimitWindowMs?, shardCount? }`; name unique per project; the two rate-limit fields must be set together (max execution *starts* per sliding window, fleet-wide) |
| GET/PATCH | `/queues/:id` | PATCH accepts any subset of the create fields |
| DELETE | `/queues/:id` | **admin** |
| POST | `/queues/:id/pause` / `/resume` | paused queues are skipped by workers entirely |
| GET | `/queues/:id/stats` | `{ byStatus, depth, running, completedLastHour, failedLastHour, avgDurationMs, oldestWaitingMs }` |

## Jobs

| Method | Path | Notes |
|---|---|---|
| POST | `/queues/:id/jobs` | see body below; `201`, or `200` with `deduplicated: true` when the idempotency key matched |
| POST | `/queues/:id/batches` | `{ name?, jobs: [...] }` (≤1000) → `{ batchId, total, jobIds }` |
| POST | `/queues/:id/workflows` | DAG creation — see *Workflows* below |
| GET | `/queues/:id/jobs?status=queued,running&type=&batchId=&search=&page=&limit=` | filterable, paginated |
| GET | `/jobs/:id` | full job incl. parsed payload/result, `shard`, `pending_deps` |
| POST | `/jobs/:id/cancel` | only `scheduled/queued/retrying`; running jobs cannot be interrupted → `409`; cascades cancellation to dependent jobs |
| POST | `/jobs/:id/retry` | `dead/canceled/completed`: re-queue with attempts reset; `retrying`: fast-forward the backoff |
| GET | `/jobs/:id/executions` | attempt history: worker, status, duration, error, result |
| GET | `/jobs/:id/logs` | job log lines (level, message, timestamp) |
| GET | `/jobs/:id/dependencies` | `{ parents: [{id,type,status}], children: [...], pendingDeps }` |

Job creation body:

```json
{
  "type": "email.send",          // required: handler name
  "payload": { "to": "a@b.c" },  // any JSON
  "priority": 0,                 // higher runs first within the queue
  "delayMs": 60000,              // delayed job (or:)
  "runAt": 1782980400000,        // absolute scheduled time (wins over delayMs)
  "timeoutMs": 60000,            // per-attempt execution timeout
  "retryPolicyId": "rp_default", // override the queue's policy
  "idempotencyKey": "order-42",  // dedupe per queue
  "dependsOn": ["job_abc"],      // run only after these jobs complete
  "shardKey": "tenant-7"         // stable shard placement on sharded queues
}
```

## Workflows (dependency DAGs)

`POST /queues/:id/workflows` creates a whole DAG atomically. `dependsOn` refers to sibling
`key`s; cycles, unknown keys and duplicate keys are rejected with `400` (nothing is created).

```json
{
  "name": "etl",
  "jobs": [
    { "key": "extract",   "type": "report.generate" },
    { "key": "transform", "type": "report.generate", "dependsOn": ["extract"] },
    { "key": "load",      "type": "report.generate", "dependsOn": ["transform"] }
  ]
}
```

→ `201 { "batchId": "bat_…", "total": 3, "jobs": { "extract": "job_…", … } }`

Children stay invisible to workers until every parent completed. A permanently failed or
canceled parent cancels its whole descendant subtree.

## Events (event-driven execution)

| Method | Path | Notes |
|---|---|---|
| POST | `/projects/:id/events` | `{ name, payload? }` → records the event and enqueues one job per enabled matching trigger, atomically → `201 { …event, jobIds }` |
| GET | `/projects/:id/events` | paginated audit list (`jobs_created` per event) |
| GET | `/projects/:id/triggers` | list triggers (with queue names) |
| POST | `/projects/:id/triggers` | `{ eventName, queueId, jobType, payload?, priority?, enabled? }`; `payload` is a template merged under the job's payload |
| PATCH | `/projects/:id/triggers/:triggerId` | any subset (e.g. `{ enabled: false }`) |
| DELETE | `/projects/:id/triggers/:triggerId` | |

Fanned-out job payloads carry the event envelope:
`{ ...triggerTemplate, "event": { "id", "name", "payload", "emittedAt" } }`.

## Schedules (recurring / cron)

| Method | Path | Notes |
|---|---|---|
| GET | `/queues/:id/schedules` | |
| POST | `/queues/:id/schedules` | `{ name, cron, timezone?, jobType, payload?, priority?, timeoutMs?, retryPolicyId? }`; cron validated (5-field, e.g. `*/5 * * * *`) |
| PATCH | `/schedules/:id` | any subset incl. `enabled`; changing cron/timezone recomputes `next_run_at` |
| DELETE | `/schedules/:id` | already-materialized jobs keep their history |

## Workers & DLQ

| Method | Path | Notes |
|---|---|---|
| GET | `/workers` | deployment-wide: status, host/pid, active vs slots, lifetime completed/failed, last heartbeat |
| GET | `/workers/:id/heartbeats` | recent liveness samples |
| POST | `/dlq/:id/requeue` | re-queues the buried job (attempts reset), marks the entry requeued → `409` if already requeued |

DLQ entries include `summary` / `summary_source` (`ai` or `heuristic`) — an automatic
failure diagnosis attached a few seconds after burial.

## WebSocket live updates

`GET /api/ws?token=<jwt>` upgrades to a WebSocket (the JWT is verified before the upgrade;
invalid tokens get `401`). The server sends `{ "type": "hello" }` on connect and debounced
`{ "type": "changed", "at": … }` pings whenever anything mutates (any API instance or any
worker process). Clients respond by re-fetching via REST — the socket itself carries no
data, so REST tenancy rules are never bypassed.

## Health

`GET /api/health` → `{ status: "ok", time }` (no auth) — for load balancer probes.
