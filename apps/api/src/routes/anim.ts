import {
  AnimPlanRequestSchema,
  AnimPlanStatusSchema,
  CreateAnimInputSchema,
  PlanStartedSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const animRoutes: RouteModule = (app, { container }): void => {
  const anim = container.services.anim;
  const planJobs = container.services.planJobs;

  // Step 1: topic -> story -> per-beat first-frame + motion prompts. Cheap text,
  // but two reasoning calls deep, so it runs in the background and is polled.
  app.post(
    "/anim/plan",
    {
      schema: {
        tags: ["anim"],
        body: AnimPlanRequestSchema,
        response: { 200: PlanStartedSchema },
      },
    },
    (req) => planJobs.start("anim", () => anim.plan(req.body.topic, req.body.style)),
  );

  app.get(
    "/anim/plan/:planId",
    {
      schema: {
        tags: ["anim"],
        params: z.object({ planId: z.string() }),
        response: { 200: AnimPlanStatusSchema },
      },
    },
    (req) => {
      const job = planJobs.get<Awaited<ReturnType<typeof anim.plan>>>(req.params.planId);
      if (!job) return { status: "error" as const, elapsedMs: 0, error: "Plan expired — start it again" };
      return { status: job.status, elapsedMs: job.elapsedMs, plan: job.result, error: job.error };
    },
  );

  // Step 2: animate the approved shots.
  app.post(
    "/anim",
    {
      schema: {
        tags: ["anim"],
        body: CreateAnimInputSchema,
        response: { 200: z.object({ sourceVideoId: z.string() }) },
      },
    },
    (req) => anim.create(req.body),
  );
};
