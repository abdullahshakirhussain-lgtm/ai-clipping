import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
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
import { calibrationRoutes } from "./routes/calibration.js";
import { categoryRoutes } from "./routes/categories.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { storyRoutes } from "./routes/story.js";
import { cookRoutes } from "./routes/cook.js";
import { lostRoutes } from "./routes/lost.js";
import { callRoutes } from "./routes/calls.js";
import { animRoutes } from "./routes/anim.js";
import { distributionRoutes } from "./routes/distribution.js";
import { clipRoutes } from "./routes/clips.js";
import { fileRoutes } from "./routes/files.js";
import { publishRoutes } from "./routes/publish.js";
import { systemRoutes } from "./routes/system.js";
import { videoRoutes } from "./routes/videos.js";
import type { RouteDeps, ZodApp } from "./routes/types.js";

export async function buildApp(container: Container) {
  const { env, logger } = container;
  const auth = createAuth(env);

  // disableRequestLogging: the dashboard polls several endpoints every few
  // seconds; per-request logs drown out the pipeline logs. Errors still log.
  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    origin: [env.WEB_URL],
    credentials: true,
  });

  // Direct video upload (the primary ingest path). Large files stream to disk;
  // 8 GB ceiling comfortably covers long source recordings.
  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1 },
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
      // Forward headers, but handle Set-Cookie separately: Headers.forEach folds
      // multiple Set-Cookie values into one comma-joined string, which corrupts
      // the session cookie. getSetCookie() returns them as a proper array.
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
      });
      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length > 0) reply.header("set-cookie", setCookies);
      const body = await response.text();
      reply.send(body.length > 0 ? body : null);
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
      categoryRoutes(typed, deps);
      analyticsRoutes(typed, deps);
      calibrationRoutes(typed, deps);
      distributionRoutes(typed, deps);
      discoveryRoutes(typed, deps);
      storyRoutes(typed, deps);
      cookRoutes(typed, deps);
      lostRoutes(typed, deps);
      callRoutes(typed, deps);
      animRoutes(typed, deps);
      systemRoutes(typed, deps);
    },
    { prefix: "/api/v1" },
  );

  return { app, auth };
}
