import { createContainer } from "@clipfactory/core";
import { startBullMqWorkers } from "@clipfactory/queue";

/**
 * Dedicated worker process for production (QUEUE_DRIVER=bullmq). Runs the
 * pipeline stage processors and a periodic analytics-sync scheduler.
 *
 * In dev (QUEUE_DRIVER=inprocess) the API process runs the pipeline itself, so
 * this process just idles with a warning — no Redis required to try the app.
 */
async function main() {
  const container = createContainer({ withHandlers: true });
  const { env, logger, handlers, dispatcher } = container;

  if (env.QUEUE_DRIVER !== "bullmq") {
    logger.warn(
      "QUEUE_DRIVER is not 'bullmq'; the API process runs the in-process pipeline. This worker will idle.",
    );
    return;
  }

  const workers = startBullMqWorkers(env.REDIS_URL, handlers, logger, {
    "clip.render": 2, // FFmpeg is CPU-heavy — keep render concurrency low
    "video.download": 2,
    "clip.enhance": 4,
    "publish.execute": 4,
  });
  logger.info("worker started — processing pipeline queues");

  // Periodic metrics sync for published posts
  const syncEvery = 6 * 60 * 60 * 1000;
  const timer = setInterval(() => {
    dispatcher.enqueue("analytics.sync", {}, { jobId: "analytics-sync" }).catch((err) => {
      logger.error({ err: String(err) }, "failed to enqueue analytics sync");
    });
  }, syncEvery);

  const shutdown = async () => {
    logger.info("shutting down worker");
    clearInterval(timer);
    await workers.close();
    await container.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
