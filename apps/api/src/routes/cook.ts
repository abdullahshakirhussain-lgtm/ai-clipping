import {
  CookPlanRequestSchema,
  CookPlanStatusSchema,
  CreateCookInputSchema,
  PlanStartedSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const cookRoutes: RouteModule = (app, { container }): void => {
  const cook = container.services.cook;
  const planJobs = container.services.planJobs;

  // Step 1: plan editable shot prompts from a dish (cheap — no video spend). The
  // planner is one high-effort reasoning call and takes minutes, so it runs in
  // the BACKGROUND and the client polls; a request held open that long gets hung
  // up on by a proxy (499) long before the model finishes.
  app.post(
    "/cook/plan",
    {
      schema: {
        tags: ["cook"],
        body: CookPlanRequestSchema,
        response: { 200: PlanStartedSchema },
      },
    },
    (req) => planJobs.start("cook", () => cook.plan(req.body.dish)),
  );

  app.get(
    "/cook/plan/:planId",
    {
      schema: {
        tags: ["cook"],
        params: z.object({ planId: z.string() }),
        response: { 200: CookPlanStatusSchema },
      },
    },
    (req) => {
      const job = planJobs.get<Awaited<ReturnType<typeof cook.plan>>>(req.params.planId);
      // An unknown id means the plan expired or the API restarted mid-think.
      // Reported as a terminal error rather than a 404 so the poller stops
      // cleanly with a message instead of treating it as a transport failure.
      if (!job) return { status: "error" as const, elapsedMs: 0, error: "Plan expired — start it again" };
      return { status: job.status, elapsedMs: job.elapsedMs, plan: job.result, error: job.error };
    },
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
