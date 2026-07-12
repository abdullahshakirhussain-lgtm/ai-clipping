import { OverviewDtoSchema } from "@clipfactory/core";
import type { RouteModule } from "./types.js";

export const analyticsRoutes: RouteModule = (app, { container }): void => {
  const svc = container.services.analytics;

  app.get(
    "/analytics/overview",
    { schema: { tags: ["analytics"], response: { 200: OverviewDtoSchema } } },
    () => svc.overview(),
  );
};
