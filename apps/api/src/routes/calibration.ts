import { CalibrationDtoSchema } from "@clipfactory/core";
import type { RouteModule } from "./types.js";

export const calibrationRoutes: RouteModule = (app, { container }): void => {
  const svc = container.services.calibration;

  app.get(
    "/calibration",
    { schema: { tags: ["calibration"], response: { 200: CalibrationDtoSchema } } },
    () => svc.get(),
  );

  app.post(
    "/calibration/recompute",
    { schema: { tags: ["calibration"], response: { 200: CalibrationDtoSchema } } },
    () => svc.recompute(),
  );
};
