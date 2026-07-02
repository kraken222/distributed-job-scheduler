/**
 * Shard assignment. Jobs with the same shard key always land on the same
 * shard, so a worker pinned to that shard sees all of a key's jobs — the
 * classic partitioning trick (cf. Kafka) for cache locality and per-key
 * fairness. Keyless jobs hash their own id, spreading them evenly.
 *
 * FNV-1a is used because it is tiny, dependency-free and deterministic
 * across processes — cryptographic strength is not needed for placement.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function shardFor(key: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  return fnv1a(key) % shardCount;
}

/** Parse WORKER_SHARDS="0,2,5" into a validated shard list (undefined = all shards). */
export function parseShardList(raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const shards = raw.split(',').map((s) => Number(s.trim()));
  if (shards.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Invalid WORKER_SHARDS value: ${raw} (expected comma-separated non-negative integers)`);
  }
  return [...new Set(shards)];
}
