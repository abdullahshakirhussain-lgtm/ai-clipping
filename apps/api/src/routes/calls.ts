import {
  CallBriefRequestSchema,
  CallBriefSchema,
  CallPlanRequestSchema,
  CallPlanStatusSchema,
  CreateCallInputSchema,
  PlanStartedSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const callRoutes: RouteModule = (app, { container }): void => {
  const calls = container.services.calls;
  const planJobs = container.services.planJobs;

  // Step 1: one line in, a full editable brief out (cheap text — no audio spend).
  // Runs in the BACKGROUND and is polled: writing the brief is one high-effort
  // reasoning call that outlives what a proxy will hold open (it 499s).
  app.post(
    "/calls/plan",
    {
      schema: {
        tags: ["calls"],
        body: CallPlanRequestSchema,
        response: { 200: PlanStartedSchema },
      },
    },
    (req) => planJobs.start("call", () => calls.plan(req.body.idea)),
  );

  app.get(
    "/calls/plan/:planId",
    {
      schema: {
        tags: ["calls"],
        params: z.object({ planId: z.string() }),
        response: { 200: CallPlanStatusSchema },
      },
    },
    (req) => {
      const job = planJobs.get<Awaited<ReturnType<typeof calls.plan>>>(req.params.planId);
      // Unknown id = expired, or the API restarted mid-think. Terminal error
      // rather than a 404 so the poller stops with a message it can show.
      if (!job) return { status: "error" as const, elapsedMs: 0, error: "Plan expired — start it again" };
      return { status: job.status, elapsedMs: job.elapsedMs, plan: job.result, error: job.error };
    },
  );

  // Step 1b: re-assemble the brief after the user edits the fields, so what they
  // read in the review box is byte-for-byte what the audio model receives.
  app.post(
    "/calls/preview",
    {
      schema: {
        tags: ["calls"],
        body: CallBriefRequestSchema,
        response: { 200: CallBriefSchema },
      },
    },
    (req) => calls.preview(req.body),
  );

  // Step 2: generate from the approved brief.
  app.post(
    "/calls",
    {
      schema: {
        tags: ["calls"],
        body: CreateCallInputSchema,
        response: { 200: z.object({ sourceVideoId: z.string() }) },
      },
    },
    (req) => calls.create(req.body),
  );
};
