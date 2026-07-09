import {
  IdParamSchema,
  SourceVideoDtoSchema,
  SourceVideoStatusSchema,
  TranscriptSegmentSchema,
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
};
