import type { Redis } from 'ioredis';
import {
  DOMAIN_CONCURRENCY_LIMITS,
} from '../types/index.js';
import { config } from '../config/index.js';

// ─── Per-Domain Redis Semaphore ───────────────────────────────────────────────
// Uses Redis INCR + EXPIRE to implement a sliding-window concurrency counter.
//
// Key schema: domain:semaphore:<domain>  →  current active SMTP connections
//
// Before opening an SMTP connection the worker:
//   1. Calls acquire() — if the counter is at the cap, it waits and retries
//   2. After the SMTP check completes (success or error) calls release()
//
// This prevents hammering any single MX provider and getting IP-banned.

const KEY_PREFIX = 'domain:semaphore:';
const POLL_INTERVAL_MS = 200; // how often to retry acquire
const MAX_WAIT_MS = 30_000;   // give up waiting after 30 s → BullMQ will retry

function semaphoreKey(domain: string): string {
  return `${KEY_PREFIX}${domain.toLowerCase()}`;
}

function getLimit(domain: string): number {
  return (
    DOMAIN_CONCURRENCY_LIMITS[domain.toLowerCase()]?.maxConcurrent ??
    config.rateLimit.defaultMaxConcurrent
  );
}

/**
 * Attempt to acquire a slot for the given domain.
 * Returns true on success, false if timed out (caller should re-queue).
 */
export async function acquireDomainSlot(
  redis: Redis,
  domain: string
): Promise<boolean> {
  const key   = semaphoreKey(domain);
  const limit = getLimit(domain);
  const ttl   = config.rateLimit.domainWindowSec;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    // Lua script: atomically increment only if under the cap
    const result = await redis.eval(
      `local cur = redis.call('GET', KEYS[1])
       if cur == false then cur = 0 else cur = tonumber(cur) end
       if cur < tonumber(ARGV[1]) then
         local new = redis.call('INCR', KEYS[1])
         redis.call('EXPIRE', KEYS[1], ARGV[2])
         return 1
       end
       return 0`,
      1,
      key,
      String(limit),
      String(ttl)
    ) as number;

    if (result === 1) return true;

    // Slot not available — wait then retry
    await sleep(POLL_INTERVAL_MS);
  }

  return false; // timed out
}

/** Release a previously acquired slot. */
export async function releaseDomainSlot(
  redis: Redis,
  domain: string
): Promise<void> {
  const key = semaphoreKey(domain);
  // Decrement but never below 0 (guard against release-without-acquire)
  await redis.eval(
    `local cur = redis.call('GET', KEYS[1])
     if cur and tonumber(cur) > 0 then
       redis.call('DECR', KEYS[1])
     end`,
    1,
    key
  );
}

/** Current concurrency usage for a domain (useful for metrics). */
export async function getDomainSlotUsage(
  redis: Redis,
  domain: string
): Promise<{ current: number; limit: number }> {
  const key    = semaphoreKey(domain);
  const raw    = await redis.get(key);
  const limit  = getLimit(domain);
  return { current: raw ? parseInt(raw, 10) : 0, limit };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
