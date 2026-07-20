import {
  CreateStoryInputSchema,
  SuggestTopicsQuerySchema,
  SuggestTopicsResponseSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const storyRoutes: RouteModule = (app, { container }): void => {
  const story = container.services.story;

  // Kick off a generated story video (lands in the Library when done).
  app.post(
    "/story",
    {
      schema: {
        tags: ["story"],
        body: CreateStoryInputSchema,
        response: { 200: z.object({ sourceVideoId: z.string() }) },
      },
    },
    (req) => story.create(req.body),
  );

  // Propose topics to seed the Create form.
  app.get(
    "/story/topics",
    {
      schema: {
        tags: ["story"],
        querystring: SuggestTopicsQuerySchema,
        response: { 200: SuggestTopicsResponseSchema },
      },
    },
    async (req) => ({ topics: await story.suggestTopics(req.query.category) }),
  );
};
