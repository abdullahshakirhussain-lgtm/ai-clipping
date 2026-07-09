import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { LocalStorage } from "@clipfactory/storage";
import { z } from "zod";
import type { RouteModule } from "./types.js";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

/**
 * Serves objects from the local storage driver (dev only). With R2 the browser
 * hits presigned/CDN URLs directly and this route is unused. Supports HTTP range
 * requests so <video> seeking works in the review UI.
 */
export const fileRoutes: RouteModule = (app, { container }): void => {
  const storage = container.storage;

  app.get(
    "/files/*",
    {
      schema: {
        tags: ["files"],
        params: z.object({ "*": z.string() }),
        hide: true,
      },
    },
    async (req, reply) => {
      if (!(storage instanceof LocalStorage)) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "local files disabled" } });
      }
      const key = decodeURIComponent(req.params["*"]);
      let absPath: string;
      try {
        absPath = storage.resolveKey(key);
      } catch {
        return reply.code(400).send({ error: { code: "BAD_KEY", message: "invalid key" } });
      }

      let size: number;
      try {
        size = (await stat(absPath)).size;
      } catch {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "file not found" } });
      }

      const ext = key.split(".").pop()?.toLowerCase() ?? "";
      const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
      const range = req.headers.range;

      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : size - 1;
        reply
          .code(206)
          .header("Content-Range", `bytes ${start}-${end}/${size}`)
          .header("Accept-Ranges", "bytes")
          .header("Content-Length", end - start + 1)
          .header("Content-Type", contentType);
        return reply.send(createReadStream(absPath, { start, end }));
      }

      reply.header("Content-Length", size).header("Content-Type", contentType).header("Accept-Ranges", "bytes");
      return reply.send(createReadStream(absPath));
    },
  );
};
