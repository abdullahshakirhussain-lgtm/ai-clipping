import {
  DiscoveredVideoDtoSchema,
  IdParamSchema,
  IngestDiscoveredInputSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const discoveryRoutes: RouteModule = (app, { container }): void => {
  const discovery = container.services.discovery;

  // Ranked Finder feed (NEW by default).
  app.get(
    "/discovery",
    {
      schema: {
        tags: ["discovery"],
        querystring: z.object({ status: z.enum(["NEW", "INGESTED", "HIDDEN"]).optional() }),
        response: { 200: z.array(DiscoveredVideoDtoSchema) },
      },
    },
    (req) => discovery.list(req.query.status ?? "NEW"),
  );

  // Manual refresh — pull the feeds now instead of waiting for the poll.
  app.post(
    "/discovery/poll",
    { schema: { tags: ["discovery"], response: { 200: z.object({ upserted: z.number() }) } } },
    () => discovery.poll(),
  );

  // Send a candidate into the pipeline with the chosen settings.
  app.post(
    "/discovery/:id/ingest",
    {
      schema: {
        tags: ["discovery"],
        params: IdParamSchema,
        body: IngestDiscoveredInputSchema,
        response: { 200: z.object({ sourceVideoId: z.string() }) },
      },
    },
    (req) => discovery.ingest(req.params.id, req.body),
  );

  app.post(
    "/discovery/:id/hide",
    {
      schema: {
        tags: ["discovery"],
        params: IdParamSchema,
        response: { 200: z.object({ hidden: z.literal(true) }) },
      },
    },
    (req) => discovery.hide(req.params.id),
  );
};
