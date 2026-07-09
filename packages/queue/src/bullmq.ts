import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import type {
  Dispatcher,
  EnqueueOptions,
  HandlerRegistry,
  JobPayloads,
  QueueLogger,
  QueueName,
} from "./types.js";
import { QUEUE_NAMES } from "./types.js";

// BullMQ and our direct dependency can resolve to different ioredis versions in
// the pnpm store; the instance is structurally compatible, so surface it as the
// ConnectionOptions BullMQ expects.
function connection(redisUrl: string): ConnectionOptions {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null }) as unknown as ConnectionOptions;
}

/** Production dispatcher backed by BullMQ/Redis. */
export class BullMqDispatcher implements Dispatcher {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly redis: IORedis;

  constructor(redisUrl: string) {
    this.redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    for (const name of QUEUE_NAMES) {
      this.queues.set(
        name,
        new Queue(name, {
          connection: this.redis as unknown as ConnectionOptions,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
            removeOnComplete: { count: 500 },
            removeOnFail: { count: 1000 },
          },
        }),
      );
    }
  }

  async enqueue<K extends QueueName>(
    queue: K,
    payload: JobPayloads[K],
    opts?: EnqueueOptions,
  ): Promise<void> {
    await this.queues.get(queue)!.add(queue, payload, {
      delay: opts?.delayMs,
      jobId: opts?.jobId,
    });
  }

  async stats() {
    return Promise.all(
      QUEUE_NAMES.map(async (queue) => {
        const counts = await this.queues.get(queue)!.getJobCounts("waiting", "active", "failed", "delayed");
        return {
          queue,
          waiting: (counts.waiting ?? 0) + (counts.delayed ?? 0),
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.redis.disconnect();
  }
}

/** Starts one BullMQ worker per registered queue (used by apps/worker). */
export function startBullMqWorkers(
  redisUrl: string,
  registry: HandlerRegistry,
  logger: QueueLogger,
  concurrency: Partial<Record<QueueName, number>> = {},
): { close(): Promise<void> } {
  const workers: Worker[] = [];
  for (const name of QUEUE_NAMES) {
    const handler = registry[name];
    if (!handler) continue;
    const worker = new Worker(
      name,
      async (job) => {
        logger.info({ queue: name, jobId: job.id }, "job started");
        await (handler as (p: unknown) => Promise<void>)(job.data);
      },
      { connection: connection(redisUrl), concurrency: concurrency[name] ?? 2 },
    );
    worker.on("failed", (job, err) =>
      logger.error({ queue: name, jobId: job?.id, err: err.message }, "job failed"),
    );
    workers.push(worker);
  }
  return {
    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
