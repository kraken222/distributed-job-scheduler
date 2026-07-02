import type { DB } from '../db/connection.js';
import type { JobRow } from '../types.js';
import { appendJobLog, claimJobs, completeJob, failJob, startJob } from '../core/claims.js';
import { heartbeat, registerWorker, setWorkerStatus } from '../core/workers.js';
import { childLogger } from '../logger.js';
import { handlers, type JobHandler } from './handlers.js';

export interface WorkerOptions {
  name: string;
  concurrency: number;
  pollMs: number;
  heartbeatMs: number;
  leaseMs: number;
  /** Shard pinning: only claim jobs on these shards (undefined = all). */
  shards?: number[];
}

/**
 * Worker runtime:
 *  - registers itself, then heartbeats on a fixed timer (also renews the
 *    leases of its in-flight jobs);
 *  - polls for work whenever it has free slots, claiming jobs atomically;
 *  - executes jobs concurrently up to `concurrency`, racing each handler
 *    against the job's timeout;
 *  - on SIGINT/SIGTERM drains: stops claiming, finishes in-flight jobs,
 *    marks itself offline. If it is killed instead, the reaper recovers its
 *    jobs when the lease expires.
 */
export class Worker {
  private id!: string;
  private readonly active = new Map<string, Promise<void>>();
  private running = false;
  private draining = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly abort = new AbortController();
  private readonly log;

  constructor(
    private readonly db: DB,
    private readonly opts: WorkerOptions,
    private readonly registry: Record<string, JobHandler> = handlers,
  ) {
    this.log = childLogger({ worker: opts.name });
  }

  get workerId(): string {
    return this.id;
  }

  async start(): Promise<void> {
    const row = registerWorker(this.db, { name: this.opts.name, concurrency: this.opts.concurrency });
    this.id = row.id;
    this.running = true;
    this.log.info(
      { workerId: this.id, concurrency: this.opts.concurrency, shards: this.opts.shards ?? 'all' },
      'worker online',
    );

    this.heartbeatTimer = setInterval(() => {
      try {
        heartbeat(this.db, { workerId: this.id, activeJobs: this.active.size, leaseMs: this.opts.leaseMs });
      } catch (err) {
        this.log.error({ err }, 'heartbeat failed');
      }
    }, this.opts.heartbeatMs);

    while (this.running) {
      const free = this.opts.concurrency - this.active.size;
      let claimed: JobRow[] = [];
      if (free > 0 && !this.draining) {
        try {
          claimed = claimJobs(this.db, this.id, free, { leaseMs: this.opts.leaseMs, shards: this.opts.shards });
        } catch (err) {
          this.log.error({ err }, 'claim failed');
        }
        for (const job of claimed) {
          const p = this.execute(job).finally(() => this.active.delete(job.id));
          this.active.set(job.id, p);
        }
      }
      if (claimed.length === 0) {
        await this.sleep(this.opts.pollMs);
      }
    }
  }

  /** Graceful shutdown: drain in-flight work, then deregister. */
  async stop(maxWaitMs = 30_000): Promise<void> {
    if (!this.running) return;
    this.draining = true;
    setWorkerStatus(this.db, this.id, 'draining');
    this.log.info({ inFlight: this.active.size }, 'draining');

    const deadline = Date.now() + maxWaitMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await Promise.race([...this.active.values()]);
    }
    if (this.active.size > 0) {
      // Ask stubborn handlers to stop; their jobs will be recovered by the reaper.
      this.abort.abort();
      this.log.warn({ stillRunning: this.active.size }, 'drain timeout; aborting remaining handlers');
      await Promise.allSettled([...this.active.values()]);
    }

    this.running = false;
    clearInterval(this.heartbeatTimer);
    setWorkerStatus(this.db, this.id, 'offline');
    this.log.info('worker offline');
  }

  private async execute(job: JobRow): Promise<void> {
    const started = startJob(this.db, job.id, this.id);
    if (!started) return; // lost the job between claim and start (e.g. reaper after a long GC pause)
    const { executionId, attempt } = started;
    const jlog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
      try {
        appendJobLog(this.db, { jobId: job.id, executionId, level, message });
      } catch {
        /* logging must never kill the job */
      }
    };
    jlog('info', `Attempt ${attempt} started on worker ${this.opts.name}`);

    const handler = this.registry[job.type];
    if (!handler) {
      // Unknown type is not transient — no amount of retrying fixes it here,
      // but another (newer) worker might know it, so use the normal retry path.
      this.settleFailure(job, executionId, `No handler registered for job type '${job.type}'`, false, jlog);
      return;
    }

    const timeoutCtl = new AbortController();
    const onOuterAbort = () => timeoutCtl.abort();
    this.abort.signal.addEventListener('abort', onOuterAbort);
    const timer = setTimeout(() => timeoutCtl.abort(), job.timeout_ms);
    try {
      const result = await Promise.race([
        handler(job.payload === null ? null : JSON.parse(job.payload), {
          jobId: job.id,
          attempt,
          signal: timeoutCtl.signal,
          log: jlog,
        }),
        new Promise((_, reject) => {
          timeoutCtl.signal.addEventListener('abort', () =>
            reject(new TimeoutError(`Timed out after ${job.timeout_ms}ms`)),
          );
        }),
      ]);
      completeJob(this.db, { jobId: job.id, executionId, workerId: this.id, result });
      jlog('info', `Attempt ${attempt} completed`);
    } catch (err) {
      const timedOut = err instanceof TimeoutError;
      const message = err instanceof Error ? err.message : String(err);
      this.settleFailure(job, executionId, message, timedOut, jlog);
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', onOuterAbort);
    }
  }

  private settleFailure(
    job: JobRow,
    executionId: string,
    error: string,
    timedOut: boolean,
    jlog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
  ): void {
    const outcome = failJob(this.db, { jobId: job.id, executionId, workerId: this.id, error, timedOut });
    if (!outcome) return;
    if (outcome.outcome === 'retry') {
      jlog('warn', `Failed: ${error} — retrying in ${outcome.delayMs}ms`);
    } else {
      jlog('error', `Failed permanently: ${error} — moved to dead letter queue`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class TimeoutError extends Error {}
