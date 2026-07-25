import { CookPlanRequestSchema, CookPlanSchema, CreateCookInputSchema } from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const cookRoutes: RouteModule = (app, { container }): void => {
  const cook = container.services.cook;

  // Step 1: plan editable shot prompts from a dish (cheap — no video spend). The
  // user reviews/edits these before generating.
  app.post(
    "/cook/plan",
    {
      schema: {
        tags: ["cook"],
        body: CookPlanRequestSchema,
        response: { 200: CookPlanSchema },
      },
    },
    (req) => cook.plan(req.body.dish),
  );

  // Step 2: generate the video from the approved (possibly edited) shots.
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
