import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '../src/core/retry.js';

const noJitter = () => 0.5; // jitter factor becomes exactly 1.0

describe('computeBackoffMs', () => {
  it('fixed strategy returns the base delay for every attempt', () => {
    const policy = { strategy: 'fixed' as const, baseDelayMs: 5000, maxDelayMs: 60000 };
    expect(computeBackoffMs(policy, 1, noJitter)).toBe(5000);
    expect(computeBackoffMs(policy, 4, noJitter)).toBe(5000);
  });

  it('linear strategy grows proportionally to the attempt number', () => {
    const policy = { strategy: 'linear' as const, baseDelayMs: 1000, maxDelayMs: 60000 };
    expect(computeBackoffMs(policy, 1, noJitter)).toBe(1000);
    expect(computeBackoffMs(policy, 2, noJitter)).toBe(2000);
    expect(computeBackoffMs(policy, 5, noJitter)).toBe(5000);
  });

  it('exponential strategy doubles each attempt', () => {
    const policy = { strategy: 'exponential' as const, baseDelayMs: 1000, maxDelayMs: 600000 };
    expect(computeBackoffMs(policy, 1, noJitter)).toBe(1000);
    expect(computeBackoffMs(policy, 2, noJitter)).toBe(2000);
    expect(computeBackoffMs(policy, 3, noJitter)).toBe(4000);
    expect(computeBackoffMs(policy, 6, noJitter)).toBe(32000);
  });

  it('caps at maxDelayMs even with positive jitter', () => {
    const policy = { strategy: 'exponential' as const, baseDelayMs: 1000, maxDelayMs: 10000 };
    expect(computeBackoffMs(policy, 20, () => 1)).toBe(10000);
  });

  it('does not overflow for huge attempt numbers', () => {
    const policy = { strategy: 'exponential' as const, baseDelayMs: 1000, maxDelayMs: 30000 };
    expect(computeBackoffMs(policy, 1000, noJitter)).toBe(30000);
  });

  it('applies bounded jitter (±10%)', () => {
    const policy = { strategy: 'fixed' as const, baseDelayMs: 10000, maxDelayMs: 60000 };
    for (let i = 0; i < 100; i++) {
      const d = computeBackoffMs(policy, 1);
      expect(d).toBeGreaterThanOrEqual(9000);
      expect(d).toBeLessThanOrEqual(11000);
    }
  });

  it('rejects invalid attempt numbers', () => {
    const policy = { strategy: 'fixed' as const, baseDelayMs: 1000, maxDelayMs: 60000 };
    expect(() => computeBackoffMs(policy, 0)).toThrow();
  });
});
