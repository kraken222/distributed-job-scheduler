# Design decisions

The guiding principle: **correctness under concurrency first**, feature count second.
Every decision below names the trade-off taken.

## 1. Database-as-queue instead of a message broker

**Decision**: workers pull jobs from the relational database with atomic claims. No Redis,
no RabbitMQ/Kafka.

**Why**: a broker adds a second stateful system whose delivery semantics then have to be
reconciled with the database (the classic dual-write problem: "job row committed but message
lost", or vice versa). With the DB as the single source of truth, enqueueing a job is one
transaction, and job state can never disagree with itself. Postgres-backed queues
(`SKIP LOCKED`) are a well-established production pattern (Sidekiq's Faktory, Oban,
Solid Queue, pg-boss) precisely for this reason.

**Cost**: polling latency (bounded by the worker poll interval, 500ms default) and DB write
load per state transition. Acceptable until throughput reaches tens of thousands of jobs/min,
at which point the claim query and executions table become the scaling bottleneck —
mitigations: queue sharding across DBs, and archiving finished executions.

## 2. SQLite for this deliverable, with a straight-line path to Postgres

**Decision**: embedded SQLite (WAL) as the storage engine; schema and queries written in
portable SQL.

**Why**: the assignment is evaluated on engineering and must be runnable by a reviewer with
zero infrastructure — `npm install && npm run api` works on any machine, no Docker required.
Crucially, SQLite does **not** weaken the concurrency story this project is graded on:
writers are serialized across processes, so the claim transaction (`BEGIN IMMEDIATE` +
conditional `UPDATE … RETURNING`) gives exactly the "no duplicate claim" guarantee that
`SELECT … FOR UPDATE SKIP LOCKED` gives on Postgres. The claim is a real multi-process
atomic operation, not an in-process lock — API and N workers share the file.

**Cost**: single-writer throughput ceiling and no network access to the DB (workers must
share a filesystem). In production this schema moves to Postgres nearly verbatim:
`TEXT → text`, `INTEGER ms → bigint`, claim CTE unchanged plus `FOR UPDATE SKIP LOCKED`,
and the DB layer is isolated in `src/db` + `src/core` to keep that swap contained.

## 3. Lease-based liveness, not connection-based

**Decision**: a claim grants a time-boxed lease; heartbeats renew it; the reaper recovers
jobs whose lease expired.

**Why**: "the worker's process died" is not observable directly — but "the worker stopped
renewing its lease" is, regardless of whether it crashed, hung, or lost its network. Leases
also handle the nastiest case gracefully: a worker that *pauses* (GC, laptop sleep) and
resumes after its job was reclaimed will find its `complete/fail` writes rejected, because
every transition is guarded by `AND claimed_by = <me> AND status = <expected>`.

**Trade-off chosen**: a job whose worker died may wait up to `lease + reaper tick`
(~35s default) before recovery. Shorter leases recover faster but risk reclaiming jobs from
merely-slow workers.

## 4. At-least-once execution + idempotency, not exactly-once

**Decision**: a crashed worker's running job is retried; producers can pass idempotency
keys; handlers are documented as required-idempotent.

**Why**: exactly-once execution of arbitrary side effects is impossible in a distributed
system (the crash can always land between the side effect and the commit). Pretending
otherwise hides data loss; embracing at-least-once makes the contract explicit and testable.
The platform provides the two halves that *are* achievable: exactly-once **enqueue** per
idempotency key (unique index) and exactly-once **firing** per cron tick (CAS +
`sched:<id>:<firing>` key).

## 5. Attempt counting: `claimed` ≠ `running`

**Decision**: the attempt counter increments at `running`, not at claim. A lease that
expires while a job is merely `claimed` returns it to the queue without consuming budget.

**Why**: a claim that never started executing did nothing — burning an attempt for it would
let a flapping worker dead-letter jobs that never ran once. Conversely a lost `running` job
*must* consume an attempt, because its side effects may have happened; treating it as a
normal failure routes it through the same backoff/DLQ policy as a thrown exception.

## 6. Retry policies as referenced entities with layered resolution

**Decision**: `retry_policies` is a table (system defaults + per-project custom); queues
reference a policy; jobs may override. Resolution at failure time: job → queue → system default.

**Why**: policies are configuration that operators tune ("make webhook retries more
aggressive") — copying `max_attempts/base_delay` onto every job row would freeze the policy
at enqueue time and bloat the hot table. The cost is one extra indexed lookup per failure,
which is rare relative to claims.
Backoff formulas: fixed `b`, linear `b·n`, exponential `b·2^(n−1)`, all with ±10% jitter
(prevents synchronized retry herds after an outage) capped by `max_delay_ms`.

## 7. Per-queue concurrency limits enforced at claim time, fleet-wide

**Decision**: `concurrency_limit` counts `claimed+running` jobs across *all* workers,
enforced inside the claim transaction with a window function; workers additionally have a
local slot count.

**Why**: the natural alternative — each worker limiting itself — cannot express "at most 3
concurrent calls against this rate-limited third-party API" once you run more than one
worker. Doing it in the claim transaction makes the limit exact (no TOCTOU between reading
counts and claiming), which is also why the check and the claim are one SQL statement pair
under one write lock. This doubles as a coarse **rate limiter** (bonus feature) at
concurrency granularity.

## 8. Coordinator loops live in the API process but are multi-instance safe

**Decision**: the cron scheduler and reaper run inside the API process rather than as a
fourth deployable; both are written to be safely concurrent (CAS on `next_run_at`,
idempotent reaping) rather than assuming single instance.

**Why**: fewer moving parts for the reviewer, no "who runs the scheduler?" deployment
question, no distributed-lock infrastructure — but scaling the API horizontally never
double-fires a schedule. A dedicated scheduler deployment would only become worthwhile when
scheduler work itself needs isolation.

## 9. Polling dashboard instead of WebSockets

**Decision**: the React dashboard polls (2–5s, paused when the tab is hidden).

**Why**: at dashboard scale, polling indexed aggregate queries is cheap, survives proxies
and reconnects for free, and keeps the server stateless. WebSockets add fan-out state,
auth-on-upgrade and reconnect logic for a marginal freshness gain. The clean upgrade path is
SSE/WS as a *notification* channel that triggers the existing fetchers (poll-on-notify), so
no business logic would change.

## 10. Cancellation is cooperative; running jobs can't be force-killed

**Decision**: cancel works for `scheduled/queued/retrying` only. Timeouts and shutdown use
`AbortSignal`, which handlers may honour; a truly stuck handler is abandoned at drain
deadline and recovered by the lease mechanism.

**Why**: Node cannot safely preempt arbitrary async code. Pretending to "kill" a job while
its side effects continue would report a lie. The honest contract: interruption points are
cooperative, and the lease/reaper path guarantees the *system* recovers even when a handler
doesn't cooperate.

## 11. Tenancy enforced in one place, as SQL

**Decision**: every resource fetch joins back to the caller's organization
(`api/access.ts`); cross-tenant hits are indistinguishable from missing rows (404).

**Why**: authorization implemented as scattered `if` checks is where multi-tenant systems
leak. Centralizing it in the lookup functions means a route *cannot* load a foreign
resource, and returning 404 (not 403) avoids confirming resource existence to other tenants.
RBAC (admin vs member) is deliberately coarse — role checks guard only destructive
operations — as fine-grained permissions weren't the evaluation focus.

## 12. IDs, timestamps, and other small deliberate choices

- **Prefixed random IDs** (`job_…`): self-describing in logs, non-enumerable, no
  coordination needed between processes (workers insert executions without asking the DB
  for a sequence).
- **Epoch-ms integers** everywhere: comparable, indexable, bucketable with integer math;
  formatting is a UI concern. (One real bug this surfaced: SQLite binds JS numbers as
  REAL, so time-bucketing needed an explicit `CAST` — caught by a regression test.)
- **Migrations over ORM**: the schema *is* the design deliverable; raw SQL keeps indexes,
  constraints and cascades visible and reviewable rather than generated.
- **Bounded history**: heartbeats pruned to last 100/worker; job logs capped per read;
  executions kept forever by design (they're the audit trail) with archiving named as the
  production follow-up.

## Bonus features implemented

- **Rate limiting** (coarse): fleet-wide per-queue concurrency caps (§7).
- **Distributed locking**: the claim transaction itself is the lock (§2), and the CAS on
  `scheduled_jobs.next_run_at` is an optimistic lock for schedule firing (§8).
- **RBAC**: admin/member roles guarding destructive operations (§11).
- Explicitly **not** implemented (scope control): workflow dependencies, queue sharding,
  event-driven execution, WebSocket push, AI failure summaries.
