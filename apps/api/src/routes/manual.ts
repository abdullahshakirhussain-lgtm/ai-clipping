import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import {
  ManualPlanRequestSchema,
  ManualPlanSchema,
  ManualPlanStatusSchema,
  ManualProgressSchema,
  PlanStartedSchema,
  ValidationError,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

/**
 * Manual clip workflow: automate everything but the paid video generation. `plan`
 * writes the script + per-clip prompts (+ character ref + voiceover for Video),
 * runs in the background (slow); the client then uploads each clip one-by-one and
 * finally assembles. Nothing here spends on video generation.
 */
export const manualRoutes: RouteModule = (app, { container }): void => {
  const manual = container.services.manual;
  const planJobs = container.services.planJobs;

  // Step 1: plan (background + poll).
  app.post(
    "/manual/plan",
    { schema: { tags: ["manual"], body: ManualPlanRequestSchema, response: { 200: PlanStartedSchema } } },
    (req) => planJobs.start("manual", () => manual.plan(req.body)),
  );
  app.get(
    "/manual/plan/:planId",
    { schema: { tags: ["manual"], params: z.object({ planId: z.string() }), response: { 200: ManualPlanStatusSchema } } },
    (req) => {
      const job = planJobs.get<Awaited<ReturnType<typeof manual.plan>>>(req.params.planId);
      if (!job) return { status: "error" as const, elapsedMs: 0, error: "Plan expired — start it again" };
      return { status: job.status, elapsedMs: job.elapsedMs, plan: job.result, error: job.error };
    },
  );

  // Reload the plan (clip prompts + upload progress) for the step-through UI.
  app.get(
    "/manual/:id",
    { schema: { tags: ["manual"], params: z.object({ id: z.string() }), response: { 200: ManualPlanSchema } } },
    (req) => manual.status(req.params.id),
  );

  // Step 2: upload ONE clip at the given index (multipart).
  app.post(
    "/manual/:id/clip/:index",
    {
      schema: {
        tags: ["manual"],
        consumes: ["multipart/form-data"],
        params: z.object({ id: z.string(), index: z.coerce.number().int().min(0) }),
        response: { 200: ManualProgressSchema },
      },
    },
    async (req) => {
      const data = await (req as unknown as { file: () => Promise<MultipartFile | undefined> }).file();
      if (!data) throw new ValidationError("No file uploaded");
      const uploadDir = join(tmpdir(), "clipfactory-manual");
      await mkdir(uploadDir, { recursive: true });
      const tmpPath = join(uploadDir, `${Date.now()}-${req.params.index}.mp4`);
      try {
        await pipeline(data.file, createWriteStream(tmpPath));
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
      const r = await manual.addClip(req.params.id, req.params.index, tmpPath);
      await rm(tmpPath, { force: true }).catch(() => {});
      return r;
    },
  );

  // Step 3: assemble once every clip is uploaded.
  app.post(
    "/manual/:id/assemble",
    { schema: { tags: ["manual"], params: z.object({ id: z.string() }), response: { 200: z.object({ sourceVideoId: z.string() }) } } },
    (req) => manual.assemble(req.params.id),
  );
};
