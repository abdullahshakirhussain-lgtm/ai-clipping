import {
  CampaignDtoSchema,
  CreateCampaignInputSchema,
  IdParamSchema,
  UpdateCampaignInputSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const campaignRoutes: RouteModule = (app, { container }): void => {
  const svc = container.services.campaigns;

  app.get("/campaigns", { schema: { tags: ["campaigns"], response: { 200: z.array(CampaignDtoSchema) } } }, () =>
    svc.list(),
  );

  app.get(
    "/campaigns/:id",
    { schema: { tags: ["campaigns"], params: IdParamSchema, response: { 200: CampaignDtoSchema } } },
    (req) => svc.get(req.params.id),
  );

  app.post(
    "/campaigns",
    { schema: { tags: ["campaigns"], body: CreateCampaignInputSchema, response: { 200: CampaignDtoSchema } } },
    (req) => svc.create(req.body),
  );

  app.patch(
    "/campaigns/:id",
    {
      schema: {
        tags: ["campaigns"],
        params: IdParamSchema,
        body: UpdateCampaignInputSchema,
        response: { 200: CampaignDtoSchema },
      },
    },
    (req) => svc.update(req.params.id, req.body),
  );

  app.post(
    "/campaigns/:id/ingest",
    {
      schema: {
        tags: ["campaigns"],
        params: IdParamSchema,
        response: { 200: z.object({ sourceVideoId: z.string() }) },
      },
    },
    (req) => svc.ingest(req.params.id),
  );
};
