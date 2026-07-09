import type {
  Dispatcher,
  EnqueueOptions,
  HandlerRegistry,
  JobPayloads,
  QueueLogger,
  QueueName,
} from "./types.js";
import { QUEUE_NAMES } from "./types.js";

interface PendingJob {
  queue: QueueName;
  payload: unknown;
  attempt: number;
  jobId?: string;
}

/**
 * Dev/no-Redis dispatcher: runs handlers in the same process on a simple FIFO
 * with retry + backoff. The API process registers the pipeline handlers, so a
 * single `pnpm dev` gives a fully working pipeline. Not for production — use
 * the BullMQ driver there.
 */
export class InProcessDispatcher implements Dispatcher {
  private readonly registry: HandlerRegistry;
  private readonly log: QueueLogger;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly pending = new Set<string>();
  private queueTail: Promise<void> = Promise.resolve();
  private counts = new Map<QueueName, { waiting: number; active: number; failed: number }>();

  constructor(opts: { registry: HandlerRegistry; logger: QueueLogger; maxAttempts?: number; backoffMs?: number }) {
    this.registry = opts.registry;
    this.log = opts.logger;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 1000;
    for (const q of QUEUE_NAMES) this.counts.set(q, { waiting: 0, active: 0, failed: 0 });
  }

  async enqueue<K extends QueueName>(
    queue: K,
    payload: JobPayloads[K],
    opts?: EnqueueOptions,
  ): Promise<void> {
    if (opts?.jobId) {
      const key = `${queue}:${opts.jobId}`;
      if (this.pending.has(key)) return;
      this.pending.add(key);
    }
    this.schedule({ queue, payload, attempt: 1, jobId: opts?.jobId }, opts?.delayMs ?? 0);
  }

  private schedule(job: PendingJob, delayMs: number): void {
    this.counts.get(job.queue)!.waiting += 1;
    const start = delayMs > 0 ? new Promise<void>((r) => setTimeout(r, delayMs)) : Promise.resolve();
    // Serialize execution: one job at a time preserves stage ordering in dev
    this.queueTail = this.queueTail.then(async () => {
      await start;
      await this.runJob(job);
    });
  }

  private async runJob(job: PendingJob): Promise<void> {
    const c = this.counts.get(job.queue)!;
    c.waiting = Math.max(0, c.waiting - 1);
    c.active += 1;
    try {
      const handler = this.registry[job.queue];
      if (!handler) throw new Error(`No handler registered for queue ${job.queue}`);
      await (handler as (p: unknown) => Promise<void>)(job.payload);
      if (job.jobId) this.pending.delete(`${job.queue}:${job.jobId}`);
    } catch (err) {
      this.log.error(
        { queue: job.queue, attempt: job.attempt, err: String(err) },
        "in-process job failed",
      );
      if (job.attempt < this.maxAttempts) {
        this.schedule(
          { ...job, attempt: job.attempt + 1 },
          this.backoffMs * 2 ** (job.attempt - 1),
        );
      } else {
        c.failed += 1;
        if (job.jobId) this.pending.delete(`${job.queue}:${job.jobId}`);
      }
    } finally {
      c.active = Math.max(0, c.active - 1);
    }
  }

  async stats() {
    return QUEUE_NAMES.map((queue) => ({ queue, ...this.counts.get(queue)! }));
  }

  async close(): Promise<void> {
    await this.queueTail;
  }
}
