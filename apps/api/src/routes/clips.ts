import {
  ClipDetailDtoSchema,
  ClipListQuerySchema,
  ClipListResponseSchema,
  IdParamSchema,
  PublishJobDtoSchema,
  PublishRequestSchema,
  ReviewInputSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

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
};
