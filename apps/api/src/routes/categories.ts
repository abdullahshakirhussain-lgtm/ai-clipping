import {
  CategoryDtoSchema,
  CreateCategoryInputSchema,
  IdParamSchema,
  RenameCategoryInputSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const categoryRoutes: RouteModule = (app, { container }): void => {
  const categories = container.services.categories;

  app.get(
    "/categories",
    { schema: { tags: ["categories"], response: { 200: z.array(CategoryDtoSchema) } } },
    () => categories.list(),
  );

  app.post(
    "/categories",
    {
      schema: {
        tags: ["categories"],
        body: CreateCategoryInputSchema,
        response: { 200: z.object({ id: z.string(), name: z.string() }) },
      },
    },
    (req) => categories.create(req.body.name),
  );

  app.patch(
    "/categories/:id",
    {
      schema: {
        tags: ["categories"],
        params: IdParamSchema,
        body: RenameCategoryInputSchema,
        response: { 200: z.object({ id: z.string(), name: z.string() }) },
      },
    },
    (req) => categories.rename(req.params.id, req.body.name),
  );

  app.delete(
    "/categories/:id",
    {
      schema: {
        tags: ["categories"],
        params: IdParamSchema,
        response: { 200: z.object({ removed: z.literal(true) }) },
      },
    },
    (req) => categories.remove(req.params.id),
  );
};
