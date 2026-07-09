import { createContainer } from "@clipfactory/core";
import { buildApp } from "./app.js";
import { bootstrapAdmin } from "./bootstrap-admin.js";

async function main() {
  // The API process also runs the in-process pipeline in dev (QUEUE_DRIVER=inprocess),
  // so handlers must be registered here. With BullMQ, apps/worker runs them instead.
  const container = createContainer({ withHandlers: true });
  const { app, auth } = await buildApp(container);

  await bootstrapAdmin(container, auth);

  const port = container.env.API_PORT;
  await app.listen({ port, host: "0.0.0.0" });
  container.logger.info(
    { port, queue: container.env.QUEUE_DRIVER, ai: container.env.AI_DRIVER, storage: container.env.STORAGE_DRIVER },
    `API listening — docs at ${container.env.API_URL}/docs`,
  );

  const shutdown = async () => {
    container.logger.info("shutting down api");
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
