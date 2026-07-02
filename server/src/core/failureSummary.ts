import type { DB } from '../db/connection.js';
import { logger } from '../logger.js';

/**
 * Failure summaries for dead-lettered jobs.
 *
 * Generation is asynchronous (a coordinator loop in the API process), never
 * on the worker's hot path: dead-lettering commits instantly and the summary
 * appears on the DLQ entry a few seconds later.
 *
 * Two engines:
 *  - AI (Anthropic Messages API) when ANTHROPIC_API_KEY is set — sees the
 *    payload shape, per-attempt errors and log tail, and writes a diagnosis;
 *  - deterministic heuristic otherwise (and as fallback on any AI error),
 *    so the feature degrades gracefully and is testable offline.
 */

export interface FailureContext {
  jobId: string;
  jobType: string;
  queueName: string;
  attempts: number;
  timeoutMs: number;
  payload: string | null;
  executions: { attempt: number; status: string; duration_ms: number | null; error: string | null }[];
  logs: { level: string; message: string }[];
}

export function buildFailureContext(db: DB, jobId: string): FailureContext | null {
  const job = db
    .prepare(
      `SELECT j.id, j.type, j.attempts, j.timeout_ms, j.payload, q.name AS queue_name
       FROM jobs j JOIN queues q ON q.id = j.queue_id WHERE j.id = ?`,
    )
    .get(jobId) as
    | { id: string; type: string; attempts: number; timeout_ms: number; payload: string | null; queue_name: string }
    | undefined;
  if (!job) return null;

  const executions = db
    .prepare(
      `SELECT attempt, status, duration_ms, error FROM job_executions
       WHERE job_id = ? ORDER BY attempt ASC LIMIT 50`,
    )
    .all(jobId) as FailureContext['executions'];
  const logs = db
    .prepare(`SELECT level, message FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT 15`)
    .all(jobId)
    .reverse() as FailureContext['logs'];

  return {
    jobId: job.id,
    jobType: job.type,
    queueName: job.queue_name,
    attempts: job.attempts,
    timeoutMs: job.timeout_ms,
    payload: job.payload === null ? null : job.payload.slice(0, 500),
    executions,
    logs,
  };
}

/** Rule-based diagnosis: pattern classification + retry-history shape. Deterministic and dependency-free. */
export function heuristicSummary(ctx: FailureContext): string {
  const errors = ctx.executions.map((e) => e.error).filter((e): e is string => e !== null);
  const unique = [...new Set(errors)];
  const timeouts = ctx.executions.filter((e) => e.status === 'timed_out').length;
  const lost = ctx.executions.filter((e) => e.status === 'lost').length;
  const total = ctx.executions.length || ctx.attempts;

  let pattern: string;
  if (unique.length <= 1 && errors.length > 0) {
    pattern = `All ${total} attempts failed identically: "${truncate(unique[0] ?? 'unknown error', 160)}".`;
  } else if (unique.length > 1) {
    pattern =
      `${total} attempts failed with ${unique.length} distinct errors ` +
      `(first: "${truncate(errors[0], 100)}", last: "${truncate(errors[errors.length - 1], 100)}").`;
  } else {
    pattern = `Job failed after ${total} attempts with no recorded error message.`;
  }

  const hints: string[] = [];
  const sample = errors.join(' ');
  if (timeouts === total && total > 0) {
    hints.push(`Every attempt hit the ${ctx.timeoutMs}ms timeout — the handler likely hangs or the budget is too small; raise timeoutMs or make the handler cooperative.`);
  } else if (timeouts > 0) {
    hints.push(`${timeouts}/${total} attempts timed out (${ctx.timeoutMs}ms limit).`);
  }
  if (lost > 0) {
    hints.push(`${lost} attempt(s) were lost to worker crashes (lease expired) — check worker stability.`);
  }
  if (/no handler registered/i.test(sample)) {
    hints.push('No worker in the fleet knows this job type — deploy a worker version that registers the handler, then requeue.');
  } else if (/(econnrefused|enotfound|etimedout|econnreset|fetch failed|socket hang up)/i.test(sample)) {
    hints.push('Errors point at downstream connectivity — verify the target service is reachable from workers before requeueing.');
  } else if (/\b5\d{2}\b/.test(sample)) {
    hints.push('Upstream 5xx responses — the dependency was failing; likely transient, requeue once it recovers.');
  } else if (/\b4\d{2}\b/.test(sample)) {
    hints.push('Upstream 4xx responses — usually a permanent request problem (auth, validation); fix the payload before requeueing, retries alone will not help.');
  } else if (unique.length === 1 && total >= 3) {
    hints.push('The error is deterministic across retries, so requeueing without a fix will land here again.');
  } else if (unique.length > 1) {
    hints.push('Mixed errors across attempts suggest flaky infrastructure rather than a bug in the job itself.');
  }

  return [`'${ctx.jobType}' on queue '${ctx.queueName}' dead-lettered after ${total} attempt(s).`, pattern, ...hints].join(' ');
}

/** Ask Claude for a diagnosis. Throws on any failure — the caller falls back to the heuristic. */
export async function aiSummary(
  ctx: FailureContext,
  cfg: { apiKey: string; model: string },
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 300,
      system:
        'You are a reliability engineer triaging a background job that permanently failed after exhausting retries. ' +
        'In 2-3 plain sentences: state the most likely root cause and whether requeueing without changes would help. ' +
        'No markdown, no preamble.',
      messages: [{ role: 'user', content: JSON.stringify(ctx) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = body.content?.find((c) => c.type === 'text')?.text?.trim();
  if (!text) throw new Error('Anthropic API returned no text content');
  return text;
}

let inFlight = false;

/**
 * Coordinator loop body: summarize up to `batch` unsummarized DLQ entries.
 * Guarded against overlapping ticks (the AI call can outlive the interval).
 */
export async function summarizeDeadLetters(
  db: DB,
  cfg: { apiKey?: string; model?: string; batch?: number },
): Promise<number> {
  if (inFlight) return 0;
  inFlight = true;
  try {
    const rows = db
      .prepare(
        `SELECT id, job_id FROM dead_letter_jobs
         WHERE summary IS NULL AND requeued_at IS NULL
         ORDER BY moved_at ASC LIMIT ?`,
      )
      .all(cfg.batch ?? 5) as { id: string; job_id: string }[];

    let done = 0;
    for (const row of rows) {
      const ctx = buildFailureContext(db, row.job_id);
      if (!ctx) continue;
      let summary = heuristicSummary(ctx);
      let source: 'ai' | 'heuristic' = 'heuristic';
      if (cfg.apiKey) {
        try {
          summary = await aiSummary(ctx, { apiKey: cfg.apiKey, model: cfg.model ?? 'claude-haiku-4-5-20251001' });
          source = 'ai';
        } catch (err) {
          logger.warn({ err: (err as Error).message, dlqId: row.id }, 'AI summary failed; using heuristic');
        }
      }
      db.prepare(`UPDATE dead_letter_jobs SET summary = ?, summary_source = ? WHERE id = ? AND summary IS NULL`).run(
        summary,
        source,
        row.id,
      );
      done++;
    }
    return done;
  } finally {
    inFlight = false;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
