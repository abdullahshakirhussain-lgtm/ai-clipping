import { QueueStatsSchema } from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const systemRoutes: RouteModule = (app, { container }): void => {
  app.get(
    "/system/queues",
    { schema: { tags: ["system"], response: { 200: QueueStatsSchema } } },
    () => container.dispatcher.stats(),
  );

  app.get(
    "/system/me",
    {
      schema: {
        tags: ["system"],
        response: {
          200: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string() }),
        },
      },
    },
    (req) => req.authUser!,
  );

  // Hard reset: wipe all domain data. Requires an explicit confirm token.
  app.post(
    "/system/wipe",
    {
      schema: {
        tags: ["system"],
        body: z.object({ confirm: z.literal("WIPE") }),
        response: { 200: z.object({ wiped: z.literal(true) }) },
      },
    },
    () => container.services.system.wipeAll(),
  );
};
