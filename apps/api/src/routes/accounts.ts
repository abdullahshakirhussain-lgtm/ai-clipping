import {
  CreateAccountInputSchema,
  IdParamSchema,
  SocialAccountDtoSchema,
  UpdateAccountInputSchema,
} from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const accountRoutes: RouteModule = (app, { container }): void => {
  const svc = container.services.accounts;

  app.get(
    "/accounts",
    { schema: { tags: ["accounts"], response: { 200: z.array(SocialAccountDtoSchema) } } },
    () => svc.list(),
  );

  app.post(
    "/accounts",
    { schema: { tags: ["accounts"], body: CreateAccountInputSchema, response: { 200: SocialAccountDtoSchema } } },
    (req) => svc.create(req.body),
  );

  app.patch(
    "/accounts/:id",
    {
      schema: {
        tags: ["accounts"],
        params: IdParamSchema,
        body: UpdateAccountInputSchema,
        response: { 200: SocialAccountDtoSchema },
      },
    },
    (req) => svc.update(req.params.id, req.body),
  );
};
