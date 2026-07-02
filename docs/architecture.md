# Architecture

## Overview

The system is three deployable units sharing one database:

```mermaid
flowchart LR
    subgraph Clients
        UI[React Dashboard<br/>WebSocket live updates<br/>+ polling fallback]
        CLI[API clients / curl<br/>emit events, enqueue jobs]
    end

    subgraph API["API process (scale horizontally)"]
        REST[Express REST API<br/>JWT auth · zod validation<br/>events → trigger fan-out]
        WS[WebSocket hub<br/>poll-on-notify pings]
        SCHED[Cron scheduler<br/>materializes due schedules]
        REAPER[Reaper<br/>recovers expired leases,<br/>marks lost workers]
        SUMM[Failure summarizer<br/>AI / heuristic DLQ diagnoses]
    end

    subgraph Workers["Worker fleet (scale horizontally)"]
        W1[Worker 1<br/>claim → execute → heartbeat<br/>optional shard pinning]
        W2[Worker 2]
        WN[Worker N]
    end

    DB[(SQLite / WAL<br/>single source of truth<br/>→ Postgres in production)]

    UI -->|HTTPS| REST
    UI <-.->|WS ping| WS
    CLI -->|HTTPS| REST
    REST --> DB
    WS --> DB
    SCHED --> DB
    REAPER --> DB
    SUMM --> DB
    W1 <--> DB
    W2 <--> DB
    WN <--> DB
```

There is intentionally **no message broker**: the database is the queue. Workers pull work
with atomic claims; nothing pushes work to them. This keeps the system simple, transactional
(job state and business data commit together), and crash-safe — see
[design-decisions.md](design-decisions.md).

## Components

### API process (`server/src/api`)

Serves REST, hosts the WebSocket hub, and runs three background coordinator loops:

- **Cron scheduler** (`core/scheduler.ts`, 1s tick): finds `scheduled_jobs` with
  `next_run_at <= now`, advances `next_run_at` with a **compare-and-set**
  (`WHERE next_run_at = <value read>`) and inserts a concrete job row for the firing.
  The CAS plus an idempotency key (`sched:<id>:<firing>`) means N API instances can run
  the loop concurrently and a firing is still enqueued exactly once.
- **Reaper** (`core/reaper.ts`, 5s tick): marks workers with stale heartbeats `lost` and
  recovers their jobs (details under *Failure recovery*).
- **Failure summarizer** (`core/failureSummary.ts`, 5s tick): attaches a diagnosis to new
  DLQ entries — Claude-generated when `ANTHROPIC_API_KEY` is set, a deterministic
  heuristic classifier otherwise. Idempotent (`WHERE summary IS NULL`), so it is
  multi-instance safe like the other loops.

**Event-driven execution** also lives here: `POST /projects/:id/events` records the event
and fans out one job per enabled matching `event_trigger` in the same transaction
(`core/events.ts`), so an event is never half-processed.

### Worker (`server/src/worker`)

A long-running process, N per deployment:

1. **Registers** itself in `workers` and starts a heartbeat timer (3s) that also renews
   the leases of its in-flight jobs.
2. **Poll loop**: when it has free slots, atomically claims up to that many due jobs
   (single `IMMEDIATE` transaction — see *Atomic claiming*). A worker started with
   `WORKER_SHARDS=0,2` claims only jobs on those shards of sharded queues.
3. **Executes** each claimed job concurrently: `claimed → running` (+ execution row,
   attempt counter), runs the registered handler racing a per-job timeout
   (`AbortSignal` passed to the handler for cooperative cancellation).
4. **Settles**: success → `completed` with stored result; failure → the resolved retry
   policy decides `retrying` (with backoff) or `dead` (+ DLQ entry).
5. **Graceful shutdown** on SIGINT/SIGTERM: stops claiming (`draining`), waits for
   in-flight jobs, aborts stragglers after a deadline, marks itself `offline`. If it is
   SIGKILLed instead, the reaper recovers its jobs when the leases expire.

### Dashboard (`web/`)

React SPA. All data flows through the same authenticated REST API, refreshed instantly by
WebSocket change notifications with a visibility-aware polling hook (2–5s) as fallback.
No privileged backdoors: the UI can do exactly what the API allows.

## Job lifecycle

```mermaid
stateDiagram-v2
    [*] --> scheduled: created with delayMs / runAt
    [*] --> queued: created (immediate)
    scheduled --> claimed: due + atomically claimed
    queued --> claimed: atomically claimed
    claimed --> running: worker starts (attempt++)
    claimed --> queued: lease expired (no attempt consumed)
    running --> completed: handler resolves
    running --> retrying: handler throws / times out / worker lost,<br/>attempts &lt; max
    running --> dead: attempts exhausted → DLQ entry
    retrying --> claimed: backoff elapsed + claimed
    scheduled --> canceled: user cancel / dependency failed
    queued --> canceled: user cancel / dependency failed
    retrying --> canceled: user cancel / dependency failed
    dead --> queued: manual retry / DLQ requeue (attempts reset)
    completed --> [*]
    canceled --> [*]
```

**Workflow dependencies** overlay this machine: a job with incomplete parents stays in
`queued`/`scheduled` but is invisible to claims until `pending_deps = 0` (each completing
parent decrements it). A parent that dies or is canceled recursively cancels its
descendants — a DAG never half-runs on missing inputs.

## Atomic claiming (no duplicate execution)

Claiming runs in a single `BEGIN IMMEDIATE` transaction (`core/claims.ts`):

1. A CTE computes per-queue **free slots** as
   `MIN(concurrency headroom, rate-limit tokens)`, skipping paused queues:
   - concurrency headroom: `concurrency_limit − count(claimed|running)`;
   - rate tokens (when the queue has a limit): `rate_limit_max − execution starts inside
     the sliding window − claimed-but-not-yet-started jobs`.
2. Candidates are filtered to **runnable** jobs only — due (`run_at <= now`), all
   dependencies complete (`pending_deps = 0`), and on the worker's shards if it is pinned —
   then ranked with a window function (`ROW_NUMBER() PARTITION BY queue`) so one claim
   never exceeds any queue's remaining capacity, ordered by
   queue priority → job priority → `run_at` → `created_at` (FIFO).
3. `UPDATE jobs SET status='claimed', claimed_by=?, lease_expires_at=? WHERE id IN (…)
   AND status IN ('queued','scheduled','retrying') RETURNING *`.

Because concurrency limits, rate limits and the dependency gate are all evaluated inside
the same write lock that performs the claim, they are exact across the whole fleet — there
is no window in which two workers can both "see" the last free slot.

SQLite serializes writers across processes, so two workers can never claim the same row —
the same guarantee `SELECT … FOR UPDATE SKIP LOCKED` gives on Postgres (the query maps
1:1 when migrating). The status re-check in the `UPDATE` makes the transition itself
compare-and-set, and every subsequent transition (`start`, `complete`, `fail`) is guarded
by `AND status = … AND claimed_by = <me>`, so a stale worker's writes are no-ops.

## Failure recovery (at-least-once execution)

Liveness is lease-based, not connection-based:

- A claim grants a **lease** (`lease_expires_at`); worker heartbeats renew leases for all
  in-flight jobs.
- If a worker dies, heartbeats stop, leases expire, and the reaper:
  - `claimed` (never started) → returned to `queued` — the attempt never began, so the
    retry budget is untouched;
  - `running` → the open execution is closed as `lost` and the job goes through the
    normal retry-policy decision (backoff retry or DLQ), exactly as if the handler had thrown.

The result is **at-least-once** semantics: a job whose worker crashed after doing side
effects but before committing `completed` will run again. Handlers are therefore required
to be idempotent, and the API supports **idempotency keys** at enqueue time
(`UNIQUE(queue_id, idempotency_key)`) to deduplicate producers.

## Live updates (WebSocket, poll-on-notify)

The dashboard opens `/api/ws` (JWT verified during the HTTP upgrade). The socket carries
**no data** — only debounced `{type:"changed"}` pings; on each ping the client re-runs its
existing REST fetchers, so tenancy filtering and response shapes stay implemented exactly
once, in the REST layer.

Change detection covers both writer populations:

- **API-local mutations** (enqueue, cancel, config changes) notify an in-process bus from a
  single middleware — no per-route instrumentation to forget.
- **Worker processes** share the SQLite file but not the API's memory; their commits are
  detected via the `data_version` pragma (bumps whenever another connection commits),
  polled every 750ms. On Postgres both paths collapse into `LISTEN/NOTIFY`.

If the socket drops, the client reconnects with backoff and meanwhile the polling hook
(2–5s, visibility-aware) keeps the UI correct — live updates are an accelerator, never a
single point of failure.
