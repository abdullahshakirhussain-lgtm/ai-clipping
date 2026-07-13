import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DistributeResultSchema,
  DistributionOverviewSchema,
  IdParamSchema,
  MarkPostedInputSchema,
  PostTaskSchema,
  RescheduleInputSchema,
} from "@clipfactory/core";
import archiver from "archiver";
import { z } from "zod";
import type { RouteModule } from "./types.js";

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const distributionRoutes: RouteModule = (app, { container }): void => {
  const dist = container.services.distribution;

  app.post(
    "/distribute",
    { schema: { tags: ["distribution"], response: { 200: DistributeResultSchema } } },
    () => dist.distribute(),
  );

  app.get(
    "/distribution/overview",
    { schema: { tags: ["distribution"], response: { 200: DistributionOverviewSchema } } },
    () => dist.overview(),
  );

  app.get(
    "/distribution/queue",
    {
      schema: {
        tags: ["distribution"],
        querystring: z.object({ accountId: z.string() }),
        response: { 200: z.array(PostTaskSchema) },
      },
    },
    (req) => dist.queue(req.query.accountId),
  );

  app.post(
    "/jobs/:id/posted",
    {
      schema: {
        tags: ["distribution"],
        params: IdParamSchema,
        body: MarkPostedInputSchema,
        response: { 200: PostTaskSchema },
      },
    },
    (req) => dist.markPosted(req.params.id, req.body.url),
  );

  app.post(
    "/jobs/:id/skip",
    { schema: { tags: ["distribution"], params: IdParamSchema, response: { 200: PostTaskSchema } } },
    (req) => dist.skip(req.params.id),
  );

  app.patch(
    "/jobs/:id/schedule",
    {
      schema: {
        tags: ["distribution"],
        params: IdParamSchema,
        body: RescheduleInputSchema,
        response: { 200: PostTaskSchema },
      },
    },
    (req) => dist.reschedule(req.params.id, req.body.scheduledAt),
  );

  // Scheduler bundle: a schedule.csv (one row per scheduled post) + each clip's
  // mp4, ready to feed a 3rd-party bulk scheduler.
  app.get(
    "/distribution/export",
    { schema: { tags: ["distribution"], querystring: z.object({ accountId: z.string().optional() }) } },
    async (req, reply) => {
      let jobs = await container.repos.publish.list({ status: "SCHEDULED" });
      if (req.query.accountId) jobs = jobs.filter((j) => j.socialAccountId === req.query.accountId);
      jobs = jobs.filter((j) => j.clip.storageKey);
      if (jobs.length === 0) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "No scheduled posts to export" } });
      }

      const tmpDir = join(tmpdir(), `dist-export-${Date.now()}`);
      await mkdir(tmpDir, { recursive: true });
      const archive = archiver("zip", { zlib: { level: 5 } });
      archive.on("end", () => void rm(tmpDir, { recursive: true, force: true }).catch(() => {}));
      archive.on("error", (err) => container.logger.error({ err: String(err) }, "distribution export error"));

      const csv: string[] = [
        ["platform", "account", "category", "scheduledAt", "caption", "hashtags", "mediaFile"].map(csvCell).join(","),
      ];
      const mediaFor = new Map<string, string>(); // clipId → filename (dedupe media)
      const usedNames = new Set<string>();
      for (const j of jobs) {
        const e = j.clip.enhancement;
        let file = mediaFor.get(j.clipId);
        if (!file) {
          const base = (e?.title ?? j.clipId).toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || j.clipId;
          let name = `${base}.mp4`;
          let n = 1;
          while (usedNames.has(name)) name = `${base}-${n++}.mp4`;
          usedNames.add(name);
          mediaFor.set(j.clipId, name);
          file = name;
          const local = join(tmpDir, name);
          await container.storage.getToFile(j.clip.storageKey!, local);
          archive.file(local, { name: `media/${name}` });
        }
        csv.push(
          [
            j.socialAccount.platform,
            j.socialAccount.handle,
            j.clip.category ?? "",
            j.scheduledAt ? j.scheduledAt.toISOString() : "",
            [e?.title, e?.description].filter(Boolean).join(" — "),
            (e?.hashtags ?? []).join(" "),
            `media/${file}`,
          ].map(csvCell).join(","),
        );
      }
      archive.append(csv.join("\n"), { name: "schedule.csv" });

      reply.header("Content-Type", "application/zip");
      reply.header("Content-Disposition", `attachment; filename="distribution-${Date.now()}.zip"`);
      reply.send(archive);
      void archive.finalize();
      return reply;
    },
  );
};
