import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { EmailJobData } from '../types/index.js';

// ─── Redis connection ─────────────────────────────────────────────────────────
// maxRetriesPerRequest=null is required by BullMQ for blocking commands.
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });

    _redis.on('error', (err: Error) => {
      console.error('[Redis] Connection error:', err);
    });
  }
  return _redis;
}

// ─── BullMQ Queue ─────────────────────────────────────────────────────────────
// One shared queue instance; jobs are processed by worker processes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _queue: Queue<EmailJobData, any, string> | null = null;

export function getQueue(): Queue<EmailJobData, any, string> {
  if (!_queue) {
    _queue = new Queue<EmailJobData>(config.redis.queueName, {
      // Cast needed: project ioredis v5.10 vs BullMQ-bundled ioredis v5.9 type mismatch
      connection: getRedis() as any,
      defaultJobOptions: {
        attempts:   config.worker.maxRetries,
        backoff: {
          type:  'exponential',
          delay: 60_000, // 1 min → 2 min → 4 min (BullMQ doubles each time)
        },
        removeOnComplete: { count: 1_000 }, // keep last 1k completed jobs in Redis
        removeOnFail:     { count: 5_000 }, // keep last 5k failed for inspection
      },
    });
  }
  return _queue!;
}

// ─── Queue Events (for monitoring / webhooks) ─────────────────────────────────
let _queueEvents: QueueEvents | null = null;

export function getQueueEvents(): QueueEvents {
  if (!_queueEvents) {
    // QueueEvents needs its own Redis connection
    const eventsRedis = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _queueEvents = new QueueEvents(config.redis.queueName, {
      connection: eventsRedis as any,
    });
  }
  return _queueEvents;
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
export async function closeQueue(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
