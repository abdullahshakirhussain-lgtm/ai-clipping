import { IdParamSchema, PublishJobDtoSchema, PublishJobListQuerySchema } from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const publishRoutes: RouteModule = (app, { container }): void => {
  const svc = container.services.publish;

  app.get(
    "/publish-jobs",
    { schema: { tags: ["publishing"], querystring: PublishJobListQuerySchema, response: { 200: z.array(PublishJobDtoSchema) } } },
    (req) => svc.list(req.query),
  );

  app.get(
    "/publish-jobs/:id",
    { schema: { tags: ["publishing"], params: IdParamSchema, response: { 200: PublishJobDtoSchema } } },
    (req) => svc.get(req.params.id),
  );

  app.post(
    "/publish-jobs/:id/retry",
    { schema: { tags: ["publishing"], params: IdParamSchema, response: { 200: PublishJobDtoSchema } } },
    (req) => svc.retry(req.params.id),
  );

  app.post(
    "/publish-jobs/:id/cancel",
    { schema: { tags: ["publishing"], params: IdParamSchema, response: { 200: PublishJobDtoSchema } } },
    (req) => svc.cancel(req.params.id),
  );
};
