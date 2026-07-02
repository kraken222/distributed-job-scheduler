/** Shared domain types. Timestamps are Unix epoch milliseconds. */

export const JOB_STATUSES = [
  'scheduled', // waiting for run_at (delayed jobs, first run of a schedule)
  'queued',    // ready to be claimed
  'claimed',   // atomically claimed by a worker, not yet running
  'running',   // handler executing on a worker
  'retrying',  // failed transiently, waiting for backoff before re-claim
  'completed', // terminal: success
  'dead',      // terminal: permanently failed, moved to the dead letter queue
  'canceled',  // terminal: canceled by a user before execution
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses a worker is allowed to claim (given run_at <= now). */
export const CLAIMABLE_STATUSES: JobStatus[] = ['queued', 'scheduled', 'retrying'];
/** Terminal statuses; no further transitions allowed. */
export const TERMINAL_STATUSES: JobStatus[] = ['completed', 'dead', 'canceled'];

export const RETRY_STRATEGIES = ['fixed', 'linear', 'exponential'] as const;
export type RetryStrategy = (typeof RETRY_STRATEGIES)[number];

export type WorkerStatus = 'online' | 'draining' | 'offline' | 'lost';
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'lost';
export type UserRole = 'admin' | 'member';

export interface RetryPolicyRow {
  id: string;
  project_id: string | null;
  name: string;
  strategy: RetryStrategy;
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  created_at: number;
}

export interface JobRow {
  id: string;
  queue_id: string;
  type: string;
  payload: string | null;
  status: JobStatus;
  priority: number;
  run_at: number;
  attempts: number;
  retry_policy_id: string | null;
  idempotency_key: string | null;
  batch_id: string | null;
  scheduled_job_id: string | null;
  timeout_ms: number;
  claimed_by: string | null;
  lease_expires_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  last_error: string | null;
  result: string | null;
  /** Shard index in [0, queue.shard_count); always 0 for unsharded queues. */
  shard: number;
  shard_key: string | null;
  /** Number of dependency parents that have not completed yet; claimable only at 0. */
  pending_deps: number;
  created_at: number;
  updated_at: number;
}

export interface QueueRow {
  id: string;
  project_id: string;
  name: string;
  priority: number;
  concurrency_limit: number;
  is_paused: number;
  retry_policy_id: string | null;
  /** Sliding-window rate limit (NULL = unlimited): max execution starts per window. */
  rate_limit_max: number | null;
  rate_limit_window_ms: number | null;
  /** Number of shards jobs hash onto; 1 = unsharded. */
  shard_count: number;
  created_at: number;
  updated_at: number;
}

export interface WorkerRow {
  id: string;
  name: string;
  hostname: string;
  pid: number;
  concurrency: number;
  status: WorkerStatus;
  started_at: number;
  last_heartbeat_at: number;
  stopped_at: number | null;
}

export interface ExecutionRow {
  id: string;
  job_id: string;
  worker_id: string;
  attempt: number;
  status: ExecutionStatus;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  result: string | null;
}

export interface ScheduledJobRow {
  id: string;
  queue_id: string;
  name: string;
  cron: string;
  timezone: string;
  job_type: string;
  payload: string | null;
  priority: number;
  timeout_ms: number;
  retry_policy_id: string | null;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeadLetterRow {
  id: string;
  job_id: string;
  queue_id: string;
  reason: string;
  attempts: number;
  moved_at: number;
  requeued_at: number | null;
  requeued_job_id: string | null;
  /** Human-readable failure diagnosis, generated asynchronously. */
  summary: string | null;
  summary_source: 'ai' | 'heuristic' | null;
}

export interface EventRow {
  id: string;
  project_id: string;
  name: string;
  payload: string | null;
  jobs_created: number;
  created_at: number;
}

export interface EventTriggerRow {
  id: string;
  project_id: string;
  queue_id: string;
  event_name: string;
  job_type: string;
  payload: string | null;
  priority: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}
