import { QueueStatsSchema } from "@clipfactory/core";
import { z } from "zod";
import type { RouteModule } from "./types.js";

export const systemRoutes: RouteModule = (app, { container }): void => {
  app.get(
    "/system/queues",
    { schema: { tags: ["system"], response: { 200: QueueStatsSchema } } },
    () => container.dispatcher.stats(),
  );

  app.get(
    "/system/me",
    {
      schema: {
        tags: ["system"],
        response: {
          200: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string() }),
        },
      },
    },
    (req) => req.authUser!,
  );

  /**
   * Pre-flight the paid Google models WITHOUT generating anything: a models.get
   * per configured model id, which costs nothing. Preview model ids get renamed,
   * and finding that out from a failed (already-charged) render is the expensive
   * way to learn it. Run this once after adding the key.
   */
  app.get(
    "/system/providers",
    {
      schema: {
        tags: ["system"],
        response: {
          200: z.object({
            ok: z.boolean(),
            checks: z.array(
              z.object({
                purpose: z.string(),
                provider: z.string(),
                model: z.string(),
                ok: z.boolean(),
                detail: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async () => {
      const checks: Array<{ purpose: string; provider: string; model: string; ok: boolean; detail: string }> = [];

      const video = container.pipeline.video as { check?: () => Promise<{ ok: boolean; model: string; detail: string; resolution: string; durationSeconds: string }> };
      if (typeof video.check === "function") {
        const r = await video.check();
        checks.push({
          purpose: `Cook video (${r.resolution}, ${r.durationSeconds}s clips)`,
          provider: "google",
          model: r.model,
          ok: r.ok,
          detail: r.detail,
        });
      } else {
        checks.push({
          purpose: "Cook video",
          provider: "mock",
          model: "—",
          ok: false,
          detail: "no GEMINI_API_KEY set — renders would produce a stub mp4",
        });
      }

      const call = container.pipeline.callAudio as { check?: () => Promise<{ ok: boolean; models: Array<{ id: string; ok: boolean; detail: string }> }> };
      if (typeof call.check === "function") {
        const r = await call.check();
        for (const m of r.models) {
          checks.push({
            purpose: m.id.includes("tts") ? "Call voices" : "Call dialogue writer",
            provider: "google",
            model: m.id,
            ok: m.ok,
            detail: m.detail,
          });
        }
      } else {
        checks.push({
          purpose: "Call audio",
          provider: "mock",
          model: "—",
          ok: false,
          detail: "no GEMINI_API_KEY set — calls would render silent",
        });
      }

      return { ok: checks.every((c) => c.ok), checks };
    },
  );

  // Hard reset: wipe all domain data. Requires an explicit confirm token.
  app.post(
    "/system/wipe",
    {
      schema: {
        tags: ["system"],
        body: z.object({ confirm: z.literal("WIPE") }),
        response: { 200: z.object({ wiped: z.literal(true) }) },
      },
    },
    () => container.services.system.wipeAll(),
  );
};
