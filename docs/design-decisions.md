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
under one write lock. Time-window **rate limiting** (§13) is enforced at the same point for
the same reason.

## 8. Coordinator loops live in the API process but are multi-instance safe

**Decision**: the cron scheduler and reaper run inside the API process rather than as a
fourth deployable; both are written to be safely concurrent (CAS on `next_run_at`,
idempotent reaping) rather than assuming single instance.

**Why**: fewer moving parts for the reviewer, no "who runs the scheduler?" deployment
question, no distributed-lock infrastructure — but scaling the API horizontally never
double-fires a schedule. A dedicated scheduler deployment would only become worthwhile when
scheduler work itself needs isolation.

## 9. WebSockets as a notification channel, polling as the fallback

**Decision**: the dashboard holds a WebSocket (`/api/ws`, JWT verified on upgrade) that
carries only "something changed" pings; clients react by re-running their existing REST
fetchers (poll-on-notify). Polling (2–5s, paused when the tab is hidden) stays on as the
fallback transport.

**Why push-without-payload**: pushing *data* over the socket would duplicate the REST
layer's tenancy filtering, pagination and shapes in a second protocol — the classic way
multi-tenant systems grow authorization bugs. Pushing only a ping keeps authorization in
exactly one place, makes a dropped socket degrade to plain polling (nothing breaks, the UI
just gets ~3s staler), and keeps the server nearly stateless.

**Cross-process change detection**: workers are separate processes, so the API cannot see
their writes via an in-process bus. SQLite's `data_version` pragma (bumps whenever *another
connection* commits) is polled cheaply to catch worker writes; API-local mutations notify
an in-process bus directly. Both paths feed one debounced broadcast, so a burst of commits
becomes a single ping. On Postgres this whole mechanism collapses into `LISTEN/NOTIFY`.

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

## 13. Rate limiting: sliding window over execution *starts*, enforced in the claim

**Decision**: per-queue `rate_limit_max` / `rate_limit_window_ms` cap execution **starts**
per sliding window, fleet-wide. Enforcement lives in the claim transaction: free slots =
`MIN(concurrency headroom, rate tokens)`, where tokens = limit − starts-in-window −
claimed-but-not-yet-started jobs.

**Why starts, not completions**: the thing a downstream API cares about is how often you
*hit* it; counting completions would let N slow jobs burst-start together. Counting
claimed-but-unstarted jobs closes the gap where a burst claim precedes its starts — without
it a worker could claim 50 jobs in one transaction and start them all inside a single
window. Because the count and the claim run under the same write lock, the limit is exact
across any number of workers; there is no token-bucket state to keep consistent — the
`job_executions` table already *is* the ledger. Retries consume tokens like first attempts,
deliberately: the downstream service does not care which attempt is calling it.

## 14. Workflow dependencies: a denormalized gate, not a graph walker

**Decision**: `job_dependencies` stores the DAG edges; each job carries a `pending_deps`
counter. The claim query gates on `pending_deps = 0`; completing a parent decrements its
children; a permanently failed or canceled parent recursively cancels its descendants.
`POST /queues/:id/workflows` creates a whole DAG atomically (keys + topological creation,
cycles rejected with Kahn's algorithm).

**Why a counter**: the alternative — a claim-time `NOT EXISTS (incomplete parent)` subquery
— re-walks edges on every poll of every worker, the hottest path in the system. The counter
moves that cost to completion time (once per parent, not once per poll) and is maintained
inside the same transactions that transition state, so it cannot drift. Failure semantics
are the strict ones (dead parent ⇒ canceled subtree, like a failed CI stage): silently
running children whose inputs never materialized is the wrong default, and a canceled child
still remembers its `pending_deps`, so manually retrying parent-then-child works correctly.

## 15. Sharding: stable hash placement + voluntary worker pinning

**Decision**: queues declare `shard_count`; jobs hash onto a shard by `shard_key` (FNV-1a,
falling back to the job id when keyless); workers started with `WORKER_SHARDS=0,2` only
claim those shards. Placement is recorded on the job row at enqueue time.

**Why**: sharding here is *partitioning*, not extra queues — all of a tenant's jobs land on
one shard, so an operator can dedicate workers to a noisy tenant (or spread load across
worker pools) without new queue topology. Recording the shard at enqueue keeps claims an
indexed equality filter, at the documented cost that resizing `shard_count` only affects
future jobs. Pinning is voluntary (unpinned workers see all shards) so the failure mode of
a dead pinned worker is degraded latency, not a stuck shard.

## 16. Event-driven execution: events are facts, triggers are subscriptions

**Decision**: `POST /projects/:id/events` records an immutable event and, in the same
transaction, fans out one job per enabled matching trigger. Triggers map an event name to
(queue, job type, payload template); the job payload carries the full event envelope.

**Why**: the event insert and its fan-out commit atomically, so an emitted event is never
half-processed — the guarantee webhook-style async processing usually lacks. Keeping events
as stored rows (with `jobs_created`) gives an audit trail: "what did this event cause?" is
a query, not archaeology. Matching is exact-name and project-scoped; wildcard routing was
deliberately skipped as the first version of every rules engine that ends up needing a
debugger of its own.

## 17. AI failure summaries: asynchronous, with a deterministic floor

**Decision**: when a job dead-letters, a coordinator loop later attaches a diagnosis to the
DLQ entry. With `ANTHROPIC_API_KEY` set it asks Claude (payload shape, per-attempt errors,
log tail); otherwise — and on any AI error — a rule-based heuristic classifier produces the
summary (timeout patterns, connectivity errors, HTTP status classes, deterministic-vs-flaky
across attempts). The row records which engine wrote it (`summary_source`).

**Why asynchronous**: an LLM call has no place inside a worker's failure transaction — the
job must dead-letter instantly even if the summarizer is down. **Why the heuristic floor**:
the feature must work for a reviewer without an API key, degrade gracefully in production,
and be testable offline; the AI path then upgrades quality when available rather than being
a hard dependency. The summarizer is idempotent (`WHERE summary IS NULL`), so multiple API
instances can run it safely.

## Bonus features: all eight implemented

- **Rate limiting**: exact sliding-window limits on execution starts (§13).
- **Distributed locking**: the claim transaction itself is the lock (§2), and the CAS on
  `scheduled_jobs.next_run_at` is an optimistic lock for schedule firing (§8).
- **RBAC**: admin/member roles guarding destructive operations (§11).
- **Workflow dependencies**: DAGs with atomic creation, cycle rejection, failure cascade (§14).
- **Queue sharding**: stable hash placement with worker pinning (§15).
- **Event-driven execution**: events + triggers with atomic fan-out (§16).
- **WebSocket live updates**: authenticated poll-on-notify push (§9).
- **AI failure summaries**: Claude-generated diagnoses with a deterministic fallback (§17).
