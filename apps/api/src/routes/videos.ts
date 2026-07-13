import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  IdParamSchema,
  SourceVideoDtoSchema,
  SourceVideoStatusSchema,
  TranscriptSegmentSchema,
  ValidationError,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

const VideoDetailSchema = SourceVideoDtoSchema.extend({
  transcript: z
    .object({
      language: z.string(),
      fullText: z.string(),
      segments: z.array(TranscriptSegmentSchema),
    })
    .nullable(),
});

export const videoRoutes: RouteModule = (app, { container }): void => {
  const svc = container.services.videos;

  app.get(
    "/videos",
    {
      schema: {
        tags: ["videos"],
        querystring: z.object({
          campaignId: z.string().optional(),
          status: SourceVideoStatusSchema.optional(),
        }),
        response: { 200: z.array(SourceVideoDtoSchema) },
      },
    },
    (req) => svc.list(req.query),
  );

  app.get(
    "/videos/:id",
    { schema: { tags: ["videos"], params: IdParamSchema, response: { 200: VideoDetailSchema } } },
    (req) => svc.get(req.params.id),
  );

  // Primary ingest: upload your own video file. Streams to a temp path, then the
  // service probes + stores it and jumps straight to transcription.
  app.post(
    "/videos/upload",
    {
      schema: {
        tags: ["videos"],
        consumes: ["multipart/form-data"],
        querystring: z.object({
          campaignId: z.string().optional(),
          captionStyle: z.enum(["bold-center", "yellow-pop", "clean-bottom"]).optional(),
          captionPosition: z.enum(["top", "middle", "bottom"]).optional(),
          reframe: z.enum(["true", "false"]).optional(),
          autoEnhance: z.enum(["true", "false"]).optional(),
          category: z.string().max(60).optional(),
        }),
        response: { 200: z.object({ sourceVideoId: z.string() }) },
      },
    },
    async (req) => {
      // @fastify/multipart decorates the request; the zod type provider doesn't
      // know about it, hence the cast.
      const data = await (req as unknown as { file: () => Promise<MultipartFile | undefined> }).file();
      if (!data) throw new ValidationError("No file uploaded");

      const uploadDir = join(tmpdir(), "clipfactory-uploads");
      await mkdir(uploadDir, { recursive: true });
      const safe = String(data.filename ?? "upload.mp4").replace(/[^\w.\-]+/g, "_");
      const tmpPath = join(uploadDir, `${Date.now()}-${safe}`);

      try {
        await pipeline(data.file, createWriteStream(tmpPath));
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
      if (data.file.truncated) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw new ValidationError("File exceeds the 8 GB upload limit");
      }

      return svc.ingestUpload({
        localPath: tmpPath,
        filename: safe,
        campaignId: req.query.campaignId,
        captionStyle: req.query.captionStyle,
        captionPosition: req.query.captionPosition,
        reframe: req.query.reframe === "true",
        autoEnhance: req.query.autoEnhance === "true",
        category: req.query.category,
      });
    },
  );
};

interface MultipartFile {
  filename?: string;
  file: NodeJS.ReadableStream & { truncated: boolean };
}
