import { createContainer } from "@clipfactory/core";
import { buildApp } from "./app.js";
import { bootstrapAdmin } from "./bootstrap-admin.js";

async function main() {
  // The API process also runs the in-process pipeline in dev (QUEUE_DRIVER=inprocess),
  // so handlers must be registered here. With BullMQ, apps/worker runs them instead.
  const container = createContainer({ withHandlers: true });
  const { app, auth } = await buildApp(container);

  await bootstrapAdmin(container, auth);

  // Railway (and most PaaS) inject PORT; fall back to the configured API_PORT.
  const port = Number(process.env.PORT) || container.env.API_PORT;
  await app.listen({ port, host: "0.0.0.0" });
  container.logger.info(
    { port, queue: container.env.QUEUE_DRIVER, ai: container.env.AI_DRIVER, storage: container.env.STORAGE_DRIVER },
    `API listening — docs at ${container.env.API_URL}/docs`,
  );

  // Finder poll: refresh the discovery feed on an interval so velocity can be
  // tracked across samples. Guarded + best-effort like the admin bootstrap; only
  // runs when DISCOVERY_ENABLED and a provider is configured. The API always
  // runs on Railway and the poll is light HTTP, so no BullMQ repeatable job.
  let pollTimer: NodeJS.Timeout | undefined;
  if (container.env.DISCOVERY_ENABLED && container.services.discovery.enabled) {
    const runPoll = () =>
      container.services.discovery
        .poll()
        .catch((err) => container.logger.warn({ err: String(err) }, "discovery poll errored"));
    void runPoll(); // once at startup
    pollTimer = setInterval(runPoll, container.env.DISCOVERY_POLL_MIN * 60_000);
    container.logger.info({ everyMin: container.env.DISCOVERY_POLL_MIN }, "discovery poll scheduled");
  }

  const shutdown = async () => {
    container.logger.info("shutting down api");
    if (pollTimer) clearInterval(pollTimer);
    await app.close();
    await container.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("API failed to start:", err);
  process.exit(1);
});
