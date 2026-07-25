import {
  CallBriefRequestSchema,
  CallBriefSchema,
  CallPlanRequestSchema,
  CallPlanSchema,
  CreateCallInputSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const callRoutes: RouteModule = (app, { container }): void => {
  const calls = container.services.calls;

  // Step 1: one line in, a full editable brief out (cheap text — no audio spend).
  app.post(
    "/calls/plan",
    {
      schema: {
        tags: ["calls"],
        body: CallPlanRequestSchema,
        response: { 200: CallPlanSchema },
      },
    },
    (req) => calls.plan(req.body.idea),
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
