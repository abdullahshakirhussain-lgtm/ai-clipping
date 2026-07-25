import { CreateCookInputSchema } from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const cookRoutes: RouteModule = (app, { container }): void => {
  const cook = container.services.cook;

  // Kick off a generated cook-in-the-wild video (lands in the Library when done).
  app.post(
    "/cook",
    {
      schema: {
        tags: ["cook"],
        body: CreateCookInputSchema,
        response: { 200: z.object({ sourceVideoId: z.string() }) },
      },
    },
    (req) => cook.create(req.body),
  );
};
