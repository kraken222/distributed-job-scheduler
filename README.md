# Distributed Job Scheduler

A production-inspired distributed job scheduling platform: REST API, horizontally-scalable
worker fleet, retries with configurable backoff, dead letter queue, cron schedules,
workflow DAGs, rate limiting, sharding, event-driven execution, and a live web dashboard
with WebSocket updates.

![stack](https://img.shields.io/badge/stack-Node%2022%20·%20TypeScript%20·%20Express%20·%20SQLite%20·%20React-blue)

## Features

- **Auth & multi-tenancy** — JWT auth; organizations → projects → queues → jobs. Cross-org
  access is impossible by construction (every query joins back to the caller's org).
  RBAC: admin/member roles gate destructive operations.
- **Queues** — priority, fleet-wide concurrency limits, pause/resume, retry policy, live stats.
- **Job types** — immediate, delayed (`delayMs`), scheduled (`runAt`), recurring (cron), batch.
- **Full lifecycle** — `scheduled → queued → claimed → running → completed`, with
  `retrying` (backoff) and `dead` (dead letter queue) branches, plus `canceled`.
- **Retry strategies** — fixed / linear / exponential backoff with jitter and caps;
  system-provided and custom per-project policies; per-queue and per-job overrides.
- **Workers** — atomic claims (no duplicate execution), concurrent execution, heartbeats,
  lease-based failure recovery, graceful shutdown (drain), per-job timeouts.
- **Observability** — execution history per attempt, per-job logs, worker registry with
  heartbeat history, queue stats, project throughput metrics.
- **Dashboard** — queue health, job explorer with search/filters/pagination, job detail with
  retry history, logs & dependency graph, workers, DLQ with requeue and automatic failure
  diagnoses, cron schedules, event triggers, retry policies with backoff previews, and a
  throughput chart. Live updates over WebSocket with polling fallback; light professional
  theme (Inter, teal accent, dark slate sidebar).

### Bonus features (all eight)

- **Workflow dependencies** — jobs can depend on other jobs; `POST /queues/:id/workflows`
  creates whole DAGs atomically (cycle detection included). Children become claimable only
  when every parent completed; a failed/canceled parent cancels its descendant subtree.
- **Rate limiting** — per-queue sliding-window limits on execution starts (`rateLimitMax`
  per `rateLimitWindowMs`), enforced exactly, fleet-wide, inside the claim transaction.
- **Distributed locking** — the atomic claim transaction is the lock (SQLite `IMMEDIATE` ≙
  Postgres `SELECT … FOR UPDATE SKIP LOCKED`); schedule firing uses an optimistic CAS.
- **Queue sharding** — queues declare `shardCount`; jobs hash onto shards by `shardKey`
  (same key ⇒ same shard); workers pin to shards with `WORKER_SHARDS=0,2`.
- **Event-driven execution** — `POST /projects/:id/events` records an event and atomically
  fans out one job per enabled trigger (event → queue/job-type subscriptions with payload
  templates), managed from the dashboard's Events page.
- **WebSocket live updates** — authenticated `/api/ws` pushes debounced change
  notifications (poll-on-notify); the dashboard shows a Live indicator and degrades to
  polling when the socket drops.
- **RBAC** — admin/member roles; destructive operations are admin-only.
- **AI failure summaries** — dead-lettered jobs get an automatic diagnosis: Claude-generated
  when `ANTHROPIC_API_KEY` is set, a deterministic heuristic classifier otherwise (works
  offline, falls back on any AI error).

## Repository layout

```
job-scheduler/
├── server/            # API + worker service (TypeScript, Node 22)
│   ├── src/
│   │   ├── api/       # Express app: routes, auth, validation, error handling
│   │   ├── core/      # domain logic: claims, retry, scheduler, reaper, stats
│   │   ├── db/        # SQLite connection, migrations, seed
│   │   └── worker/    # worker runtime + job handlers
│   └── tests/         # Vitest suite (82 tests)
├── web/               # React dashboard (Vite)
└── docs/              # architecture, ER diagram, API reference, design decisions
```

## Quick start

Prerequisites: **Node.js ≥ 20** (no database server needed — storage is embedded SQLite).

```bash
# 1. API + coordinator (cron scheduler + reaper)
cd server
npm install
npm run seed        # optional: demo org, queues, jobs (demo@example.com / demo1234)
npm run api         # -> http://localhost:4000

# 2. Workers — start as many as you like, each in its own terminal
cd server
npm run worker
WORKER_NAME=worker-2 npm run worker   # a second one, etc.

# 3. Dashboard
cd web
npm install
npm run dev         # -> http://localhost:5173 (proxies /api to :4000)
```

Sign in with the seeded demo account (`demo@example.com` / `demo1234`) or register a new
organization. Enqueue `demo.sleep` / `demo.flaky` / `demo.fail` jobs from the queue page and
watch them flow through workers, retries and the DLQ.

The seed also demonstrates every bonus feature: an ETL **workflow DAG** on the `reports`
queue, a **rate-limited** `third-party-api` queue (5 starts / 10s), a **sharded**
`per-tenant` queue (4 shards, jobs keyed by tenant), a `user.signup` **event trigger**
(emit one from the Events page and watch it fan out), and an automatic **failure diagnosis**
on the dead-lettered `demo.fail` job.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `DATABASE_FILE` | `<repo>/data/scheduler.db` | SQLite file shared by API & workers |
| `JWT_SECRET` | dev value | **set in production** |
| `WORKER_NAME` | `worker-<pid>` | display name of a worker |
| `WORKER_CONCURRENCY` | `5` | jobs one worker runs at once |
| `WORKER_SHARDS` | all shards | comma-separated shard pinning, e.g. `0,2` |
| `LEASE_MS` | `30000` | claim lease; expired leases are recovered by the reaper |
| `WORKER_STALE_MS` | `15000` | heartbeat age after which a worker is `lost` |
| `ANTHROPIC_API_KEY` | unset | enables AI-generated DLQ failure summaries (heuristic otherwise) |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | model used for failure summaries |

### Tests

```bash
cd server
npm test          # 82 tests: retry math, atomic claims, lifecycle, reaper, cron, API, worker
                  # integration, workflow DAGs, rate limiting, sharding, events, failure
                  # summaries, WebSocket auth + notifications
npm run typecheck
```

## Documentation

- [Architecture](docs/architecture.md) — components, data flow, failure recovery
- [Database design / ER diagram](docs/er-diagram.md) — tables, keys, indexes, cascades
- [API reference](docs/api.md) — every endpoint with request/response shapes
- [Design decisions](docs/design-decisions.md) — major trade-offs and why

## Demo job handlers

| Type | Behaviour |
|---|---|
| `email.send` | simulated email delivery (~0.3–0.7s) |
| `report.generate` | simulated heavy job (~1–3s) |
| `http.request` | real HTTP GET of `payload.url` |
| `math.fibonacci` | CPU-bound fib(`payload.n`) |
| `demo.sleep` | sleeps `payload.ms` — great for testing concurrency limits |
| `demo.flaky` | fails with probability `payload.failRate` (default 0.5) — exercises retries |
| `demo.fail` | always fails — exercises retry → dead letter path |
