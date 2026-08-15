import {
  CreateLostInputSchema,
  LostPlanRequestSchema,
  LostPlanStatusSchema,
  LostPreviewRequestSchema,
  LostPreviewStatusSchema,
  LostSuggestRequestSchema,
  LostSuggestResponseSchema,
  PlanStartedSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

/**
 * Lost Chronicles — the cost gate lives here: `plan` (cheap text) and `preview`
 * (cheap ~$0.04 still) both run in the background and the client polls, so the
 * user iterates for pennies; `POST /lost` is the only endpoint that spends Veo,
 * and only ever on an ALREADY-APPROVED still (passed by storage key).
 */
export const lostRoutes: RouteModule = (app, { container }): void => {
  const lost = container.services.lost;
  const planJobs = container.services.planJobs;

  // Scene suggester (cheap, synchronous under a deadline; optional ?hint=).
  app.get(
    "/lost/suggest",
    { schema: { tags: ["lost"], querystring: LostSuggestRequestSchema, response: { 200: LostSuggestResponseSchema } } },
    async (req) => ({ scenes: await lost.suggestScenes(req.query.hint) }),
  );

  // Step 1: plan the scene → editable still + motion prompts (no video spend).
  app.post(
    "/lost/plan",
    { schema: { tags: ["lost"], body: LostPlanRequestSchema, response: { 200: PlanStartedSchema } } },
    (req) => planJobs.start("lost", () => lost.plan(req.body)),
  );
  app.get(
    "/lost/plan/:planId",
    { schema: { tags: ["lost"], params: z.object({ planId: z.string() }), response: { 200: LostPlanStatusSchema } } },
    (req) => {
      const job = planJobs.get<Awaited<ReturnType<typeof lost.plan>>>(req.params.planId);
      if (!job) return { status: "error" as const, elapsedMs: 0, error: "Plan expired — start it again" };
      return { status: job.status, elapsedMs: job.elapsedMs, plan: job.result, error: job.error };
    },
  );

  // Step 2: preview the anime still (cheap — iterate until it's perfect).
  app.post(
    "/lost/preview/plan",
    { schema: { tags: ["lost"], body: LostPreviewRequestSchema, response: { 200: PlanStartedSchema } } },
    (req) => planJobs.start("lost-preview", () => lost.previewStill(req.body.stillPrompt)),
  );
  app.get(
    "/lost/preview/plan/:planId",
    { schema: { tags: ["lost"], params: z.object({ planId: z.string() }), response: { 200: LostPreviewStatusSchema } } },
    (req) => {
      const job = planJobs.get<Awaited<ReturnType<typeof lost.previewStill>>>(req.params.planId);
      if (!job) return { status: "error" as const, elapsedMs: 0, error: "Preview expired — try again" };
      return { status: job.status, elapsedMs: job.elapsedMs, plan: job.result, error: job.error };
    },
  );

  // Step 3: render — animate the APPROVED still (the one paid Veo call).
  app.post(
    "/lost",
    { schema: { tags: ["lost"], body: CreateLostInputSchema, response: { 200: z.object({ sourceVideoId: z.string() }) } } },
    (req) => lost.create(req.body),
  );
};
