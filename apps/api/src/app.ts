import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import apiReference from "@scalar/fastify-api-reference";
import { AppError, type Container } from "@clipfactory/core";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { ZodError } from "zod";
import { createAuth } from "./auth.js";
import { requireAuth } from "./plugins/auth-context.js";
import { accountRoutes } from "./routes/accounts.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { clipRoutes } from "./routes/clips.js";
import { fileRoutes } from "./routes/files.js";
import { publishRoutes } from "./routes/publish.js";
import { systemRoutes } from "./routes/system.js";
import { videoRoutes } from "./routes/videos.js";
import type { RouteDeps, ZodApp } from "./routes/types.js";

export async function buildApp(container: Container) {
  const { env, logger } = container;
  const auth = createAuth(env);

  const app = Fastify({ loggerInstance: logger }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: [env.WEB_URL],
    credentials: true,
  });

  // Uniform error envelope
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: { code: "VALIDATION_ERROR", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } });
    }
    if (err.validation) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
    }
    logger.error({ err: err.message, stack: err.stack }, "unhandled error");
    return reply.code(err.statusCode ?? 500).send({
      error: { code: "INTERNAL_ERROR", message: env.NODE_ENV === "production" ? "Internal error" : err.message },
    });
  });

  // OpenAPI docs
  await app.register(swagger, {
    openapi: {
      info: { title: "AI Clipping Factory API", version: "0.1.0" },
      tags: [
        { name: "campaigns" }, { name: "videos" }, { name: "clips" },
        { name: "publishing" }, { name: "accounts" }, { name: "analytics" }, { name: "system" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(apiReference, { routePrefix: "/docs" });

  app.get("/health", { schema: { hide: true } }, () => ({ status: "ok" }));

  // Better Auth — handle every method on /api/auth/*
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: { hide: true },
    async handler(request, reply) {
      const url = new URL(request.url, env.API_URL);
      const headers = new Headers();
      for (const [k, v] of Object.entries(request.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      }
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          body: request.method === "POST" ? JSON.stringify(request.body ?? {}) : undefined,
        }),
      );
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      reply.send(response.body ? await response.text() : null);
    },
  });

  const deps: RouteDeps = { container, auth };

  // Public file serving (dev local storage)
  await app.register(
    async (instance) => {
      fileRoutes(instance as unknown as ZodApp, deps);
    },
    { prefix: "/api/v1" },
  );

  // Authenticated v1 API
  await app.register(
    async (instance) => {
      instance.addHook("preHandler", requireAuth(auth));
      const typed = instance as unknown as ZodApp;
      campaignRoutes(typed, deps);
      videoRoutes(typed, deps);
      clipRoutes(typed, deps);
      publishRoutes(typed, deps);
      accountRoutes(typed, deps);
      analyticsRoutes(typed, deps);
      systemRoutes(typed, deps);
    },
    { prefix: "/api/v1" },
  );

  return { app, auth };
}
