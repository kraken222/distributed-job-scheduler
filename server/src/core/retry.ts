import type { RetryStrategy } from '../types.js';

export interface BackoffPolicy {
  strategy: RetryStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Delay before the next attempt, given the attempt number that just failed
 * (1-based: attempt=1 means the first execution failed).
 *
 *   fixed:       base, base, base, ...
 *   linear:      base, 2*base, 3*base, ...
 *   exponential: base, 2*base, 4*base, 8*base, ...
 *
 * A ±10% jitter is applied so a burst of jobs failing together does not
 * retry as a synchronized thundering herd. The result is capped at
 * maxDelayMs (jitter included, so the cap is a hard upper bound).
 */
export function computeBackoffMs(
  policy: BackoffPolicy,
  failedAttempt: number,
  random: () => number = Math.random,
): number {
  if (failedAttempt < 1) throw new Error(`failedAttempt must be >= 1, got ${failedAttempt}`);
  let delay: number;
  switch (policy.strategy) {
    case 'fixed':
      delay = policy.baseDelayMs;
      break;
    case 'linear':
      delay = policy.baseDelayMs * failedAttempt;
      break;
    case 'exponential':
      // Cap the exponent so the intermediate value cannot overflow.
      delay = policy.baseDelayMs * Math.pow(2, Math.min(failedAttempt - 1, 30));
      break;
  }
  const jitter = 1 + (random() * 0.2 - 0.1);
  return Math.min(Math.round(delay * jitter), policy.maxDelayMs);
}
