import {
  ClipAnalyticsDtoSchema,
  IdParamSchema,
  OkResponseSchema,
  OverviewDtoSchema,
  RevenueDtoSchema,
} from "@clipfactory/core";
import type { RouteModule } from "./types.js";

export const analyticsRoutes: RouteModule = (app, { container }): void => {
  const svc = container.services.analytics;

  app.get(
    "/analytics/overview",
    { schema: { tags: ["analytics"], response: { 200: OverviewDtoSchema } } },
    () => svc.overview(),
  );

  app.get(
    "/analytics/revenue",
    { schema: { tags: ["analytics"], response: { 200: RevenueDtoSchema } } },
    () => svc.revenue(),
  );

  app.get(
    "/analytics/clips/:id",
    { schema: { tags: ["analytics"], params: IdParamSchema, response: { 200: ClipAnalyticsDtoSchema } } },
    (req) => svc.clip(req.params.id),
  );

  app.post(
    "/analytics/sync",
    { schema: { tags: ["analytics"], response: { 200: OkResponseSchema } } },
    async () => {
      await svc.triggerSync();
      return { ok: true as const };
    },
  );
};
