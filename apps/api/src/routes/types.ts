import type { Container } from "@clipfactory/core";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Auth } from "../auth.js";

/** Fastify instance with the zod type provider applied. */
export type ZodApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface RouteDeps {
  container: Container;
  auth: Auth;
}

/** A route module registers endpoints on a zod-typed Fastify instance. */
export type RouteModule = (app: ZodApp, deps: RouteDeps) => void;
