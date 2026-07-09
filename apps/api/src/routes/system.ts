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
};
