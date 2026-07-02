/**
 * Job handler registry. A handler receives the parsed payload and a context
 * with a logger and an AbortSignal (fired on timeout / shutdown so
 * long-running handlers can stop cooperatively).
 *
 * Handlers must be idempotent: the platform guarantees *at-least-once*
 * execution (a worker crash after side effects but before the commit of
 * 'completed' leads to a re-run).
 */

export interface HandlerContext {
  jobId: string;
  attempt: number;
  signal: AbortSignal;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export type JobHandler = (payload: any, ctx: HandlerContext) => Promise<unknown>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

export const handlers: Record<string, JobHandler> = {
  /** Simulated email delivery — the classic background job. */
  'email.send': async (payload, ctx) => {
    const to = payload?.to ?? 'nobody@example.com';
    ctx.log('info', `Rendering template for ${to}`);
    await sleep(150 + Math.random() * 400, ctx.signal);
    ctx.log('info', `Handing off to SMTP relay`);
    await sleep(100 + Math.random() * 300, ctx.signal);
    return { delivered: true, to };
  },

  /** Simulated heavy report generation. */
  'report.generate': async (payload, ctx) => {
    const rows = payload?.rows ?? 10_000;
    ctx.log('info', `Aggregating ${rows} rows`);
    await sleep(500 + Math.random() * 2000, ctx.signal);
    ctx.log('info', 'Rendering PDF');
    await sleep(300 + Math.random() * 700, ctx.signal);
    return { url: `/reports/${ctx.jobId}.pdf`, rows };
  },

  /** Real network call: GET a URL and report status. */
  'http.request': async (payload, ctx) => {
    if (!payload?.url) throw new Error('payload.url is required');
    ctx.log('info', `GET ${payload.url}`);
    const res = await fetch(payload.url, { signal: ctx.signal });
    ctx.log('info', `Response ${res.status}`);
    return { status: res.status, ok: res.ok };
  },

  /** CPU-bound demo. */
  'math.fibonacci': async (payload, ctx) => {
    const n = Math.min(payload?.n ?? 30, 42);
    ctx.log('info', `Computing fib(${n})`);
    const fib = (k: number): number => (k <= 1 ? k : fib(k - 1) + fib(k - 2));
    return { n, value: fib(n) };
  },

  /** Sleeps payload.ms — useful for testing concurrency limits and timeouts. */
  'demo.sleep': async (payload, ctx) => {
    const ms = payload?.ms ?? 1000;
    ctx.log('info', `Sleeping ${ms}ms`);
    await sleep(ms, ctx.signal);
    return { sleptMs: ms };
  },

  /** Fails with probability payload.failRate (default 0.5) — exercises retries. */
  'demo.flaky': async (payload, ctx) => {
    const failRate = payload?.failRate ?? 0.5;
    await sleep(100 + Math.random() * 300, ctx.signal);
    if (Math.random() < failRate) {
      ctx.log('error', 'Simulated transient failure');
      throw new Error(`Transient failure (failRate=${failRate})`);
    }
    return { lucky: true };
  },

  /** Always fails — exercises the retry → dead letter path. */
  'demo.fail': async (_payload, ctx) => {
    await sleep(100, ctx.signal);
    ctx.log('error', 'This job always fails');
    throw new Error('Permanent simulated failure');
  },
};
