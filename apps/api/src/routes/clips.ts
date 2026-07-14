import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClipBulkInputSchema,
  ClipDetailDtoSchema,
  ClipListQuerySchema,
  ClipListResponseSchema,
  ClipOutcomeSchema,
  IdParamSchema,
  PublishJobDtoSchema,
  PublishRequestSchema,
  ReviewInputSchema,
  SetClipCategoryInputSchema,
  SetOutcomeInputSchema,
} from "@clipfactory/core";
import archiver from "archiver";
import { z } from "zod";
import type { RouteModule } from "./types.js";

/** CSV-escape a single cell. */
function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const clipRoutes: RouteModule = (app, { container }): void => {
  const clips = container.services.clips;
  const review = container.services.review;
  const publish = container.services.publish;

  app.get(
    "/clips",
    { schema: { tags: ["clips"], querystring: ClipListQuerySchema, response: { 200: ClipListResponseSchema } } },
    (req) => clips.list(req.query),
  );

  app.get(
    "/clips/:id",
    { schema: { tags: ["clips"], params: IdParamSchema, response: { 200: ClipDetailDtoSchema } } },
    (req) => clips.get(req.params.id),
  );

  app.post(
    "/clips/:id/review",
    {
      schema: {
        tags: ["clips"],
        params: IdParamSchema,
        body: ReviewInputSchema,
        response: {
          200: z.object({
            clipId: z.string(),
            status: z.string(),
            reprocessing: z.boolean(),
          }),
        },
      },
    },
    (req) => review.review(req.params.id, req.authUser!.id, req.body),
  );

  app.post(
    "/clips/:id/publish",
    {
      schema: {
        tags: ["clips"],
        params: IdParamSchema,
        body: PublishRequestSchema,
        response: { 200: z.array(PublishJobDtoSchema) },
      },
    },
    (req) => publish.publishClip(req.params.id, req.body),
  );

  // Label a clip's real-world outcome (feeds score calibration).
  app.post(
    "/clips/:id/outcome",
    {
      schema: {
        tags: ["clips"],
        params: IdParamSchema,
        body: SetOutcomeInputSchema,
        response: { 200: z.object({ id: z.string(), outcome: ClipOutcomeSchema.nullable() }) },
      },
    },
    (req) => clips.setOutcome(req.params.id, req.body.outcome),
  );

  // Bulk grid cull: keep/discard many clips at once.
  app.post(
    "/clips/bulk",
    {
      schema: {
        tags: ["clips"],
        body: ClipBulkInputSchema,
        response: { 200: z.object({ updated: z.number() }) },
      },
    },
    (req) => clips.bulkCull(req.body.ids, req.body.action === "keep"),
  );

  // Reassign the routing category on one or many clips (post-render).
  app.post(
    "/clips/category",
    {
      schema: {
        tags: ["clips"],
        body: SetClipCategoryInputSchema,
        response: { 200: z.object({ updated: z.number() }) },
      },
    },
    (req) => clips.setCategory(req.body.ids, req.body.category),
  );

  // Bulk export: stream a zip of the selected clips' rendered mp4s plus a
  // captions.csv sidecar (title/description/hashtags/scores) for manual posting.
  app.get(
    "/clips/export",
    {
      schema: {
        tags: ["clips"],
        querystring: z.object({ ids: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const ids = (req.query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const rows = ids.length
        ? await container.repos.clips.byIds(ids)
        : (await container.repos.clips.list({ status: "APPROVED", kept: true, take: 500 }))[0];
      const renderable = rows.filter((c) => c.storageKey);
      if (renderable.length === 0) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No rendered clips to export" } });
      }

      const tmpDir = join(tmpdir(), `clip-export-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      const archive = archiver("zip", { zlib: { level: 5 } });
      archive.on("end", () => void rm(tmpDir, { recursive: true, force: true }).catch(() => {}));
      archive.on("error", (err) => {
        container.logger.error({ err: String(err) }, "clip export archive error");
      });

      const csv: string[] = [
        ["filename", "title", "description", "hashtags", "hook", "startSec", "endSec", "hookScore", "viralScore", "overallScore"]
          .map(csvCell)
          .join(","),
      ];
      const used = new Set<string>();
      for (const clip of renderable) {
        const e = clip.enhancement;
        let base = (e?.title ?? clip.id).toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || clip.id;
        let name = base;
        let n = 1;
        while (used.has(name)) name = `${base}-${n++}`;
        used.add(name);
        const filename = `${name}.mp4`;
        const local = join(tmpDir, filename);
        await container.storage.getToFile(clip.storageKey!, local);
        archive.file(local, { name: filename });
        csv.push(
          [
            filename,
            e?.title ?? "",
            e?.description ?? "",
            (e?.hashtags ?? []).join(" "),
            clip.detectionReason ?? "",
            clip.startSec.toFixed(1),
            clip.endSec.toFixed(1),
            clip.hookScore,
            clip.viralScore,
            clip.overallScore,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      archive.append(csv.join("\n"), { name: "captions.csv" });

      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", `attachment; filename="clips-${Date.now()}.zip"`);
      reply.send(archive);
      void archive.finalize();
      return reply;
    },
  );
};
