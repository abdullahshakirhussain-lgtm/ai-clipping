/** Pipeline queue names. One queue per stage keeps concurrency tunable per stage. */
export const QUEUE_NAMES = [
  "video.download",
  "video.transcribe",
  "clip.detect",
  "clip.render",
  "clip.enhance",
  "story.generate",
  "publish.execute",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Typed payload per queue — enqueue/handler signatures derive from this map. */
export interface JobPayloads {
  "video.download": { sourceVideoId: string };
  "video.transcribe": { sourceVideoId: string };
  "clip.detect": { sourceVideoId: string };
  "clip.render": { clipId: string };
  "clip.enhance": { clipId: string };
  "story.generate": { sourceVideoId: string };
  "publish.execute": { publishJobId: string };
}

export interface EnqueueOptions {
  /** Delay before the job becomes runnable. */
  delayMs?: number;
  /** Idempotency key — a queue never holds two pending jobs with the same id. */
  jobId?: string;
}

export interface Dispatcher {
  enqueue<K extends QueueName>(
    queue: K,
    payload: JobPayloads[K],
    opts?: EnqueueOptions,
  ): Promise<void>;
  /** Pending + active counts per queue, for the dashboard. */
  stats(): Promise<Array<{ queue: QueueName; waiting: number; active: number; failed: number }>>;
  close(): Promise<void>;
}

export type JobHandler<K extends QueueName> = (payload: JobPayloads[K]) => Promise<void>;

export type HandlerRegistry = {
  [K in QueueName]?: JobHandler<K>;
};

export interface QueueLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}
