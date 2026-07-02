# Distributed Job Scheduler

A production-inspired distributed job scheduling platform: REST API, horizontally-scalable
worker fleet, retries with configurable backoff, dead letter queue, cron schedules, and a
live web dashboard.

![stack](https://img.shields.io/badge/stack-Node%2022%20·%20TypeScript%20·%20Express%20·%20SQLite%20·%20React-blue)

## Features

- **Auth & multi-tenancy** — JWT auth; organizations → projects → queues → jobs. Cross-org
  access is impossible by construction (every query joins back to the caller's org).
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
  retry history & logs, workers, DLQ with requeue, cron schedule management, retry policy
  management with backoff previews, and a throughput chart. Jobs can be enqueued from the UI
  as immediate, delayed (ms), scheduled (absolute run-at time) or batch. Live updates via
  polling; light professional theme (Inter, teal accent, dark slate sidebar).

## Repository layout

```
job-scheduler/
├── server/            # API + worker service (TypeScript, Node 22)
│   ├── src/
│   │   ├── api/       # Express app: routes, auth, validation, error handling
│   │   ├── core/      # domain logic: claims, retry, scheduler, reaper, stats
│   │   ├── db/        # SQLite connection, migrations, seed
│   │   └── worker/    # worker runtime + job handlers
│   └── tests/         # Vitest suite (53 tests)
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

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `DATABASE_FILE` | `<repo>/data/scheduler.db` | SQLite file shared by API & workers |
| `JWT_SECRET` | dev value | **set in production** |
| `WORKER_NAME` | `worker-<pid>` | display name of a worker |
| `WORKER_CONCURRENCY` | `5` | jobs one worker runs at once |
| `LEASE_MS` | `30000` | claim lease; expired leases are recovered by the reaper |
| `WORKER_STALE_MS` | `15000` | heartbeat age after which a worker is `lost` |

### Tests

```bash
cd server
npm test          # 53 tests: retry math, atomic claims, lifecycle, reaper, cron, API, worker integration
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
