import { describe, expect, it, vi } from "vitest";
import { PublisherNotConfiguredError } from "@clipfactory/publishers";
import { runPublish } from "./stages.js";
import type { PipelineContext } from "./context.js";

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job1",
    clipId: "clip1",
    attempts: 0,
    maxAttempts: 3,
    externalPostId: null,
    status: "RUNNING",
    socialAccount: { id: "acc1", platform: "TIKTOK", handle: "@x", credentials: null },
    clip: {
      storageKey: "clips/clip1/clip.mp4",
      enhancement: { title: "t", description: "d", hashtags: [] },
    },
    ...overrides,
  };
}

function makeCtx(opts: {
  publish: () => Promise<any>;
  job?: Record<string, unknown>;
}): { ctx: PipelineContext; enqueue: any; updateJob: any; addAttempt: any } {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const updateJob = vi.fn().mockResolvedValue({});
  const addAttempt = vi.fn().mockResolvedValue({});
  const ctx = {
    repos: {
      publish: {
        transition: vi.fn().mockResolvedValue(true),
        byId: vi.fn().mockResolvedValue(baseJob(opts.job)),
        update: updateJob,
        addAttempt,
      },
      clips: { update: vi.fn().mockResolvedValue({}) },
    },
    storage: {
      getToFile: vi.fn().mockResolvedValue(undefined),
      getUrl: vi.fn().mockResolvedValue("https://x/clip.mp4"),
    },
    dispatcher: { enqueue },
    publisherFor: () => ({ platform: "TIKTOK", publish: opts.publish, fetchMetrics: vi.fn() }),
    logger: { info: vi.fn(), error: vi.fn() },
    workRoot: process.cwd() + "/.data/test-work",
  } as unknown as PipelineContext;
  return { ctx, enqueue, updateJob, addAttempt };
}

describe("runPublish retry logic", () => {
  it("marks PUBLISHED and logs a successful attempt", async () => {
    const { ctx, updateJob, addAttempt } = makeCtx({
      publish: async () => ({ externalPostId: "p1", externalUrl: "u", raw: {} }),
    });
    await runPublish(ctx, "job1");
    expect(addAttempt).toHaveBeenCalledWith("job1", expect.objectContaining({ success: true }));
    expect(updateJob).toHaveBeenCalledWith(
      "job1",
      expect.objectContaining({ status: "PUBLISHED", externalPostId: "p1" }),
    );
  });

  it("re-queues with backoff when a transient error occurs and attempts remain", async () => {
    const { ctx, enqueue, updateJob } = makeCtx({
      publish: async () => {
        throw new Error("network blip");
      },
    });
    await expect(runPublish(ctx, "job1")).rejects.toThrow("network blip");
    expect(updateJob).toHaveBeenCalledWith("job1", expect.objectContaining({ status: "QUEUED" }));
    expect(enqueue).toHaveBeenCalledWith(
      "publish.execute",
      { publishJobId: "job1" },
      expect.objectContaining({ delayMs: expect.any(Number) }),
    );
  });

  it("fails immediately (no retry) when the publisher is not configured", async () => {
    const { ctx, enqueue, updateJob } = makeCtx({
      publish: async () => {
        throw new PublisherNotConfiguredError("TIKTOK", "missing token");
      },
    });
    await expect(runPublish(ctx, "job1")).rejects.toBeInstanceOf(PublisherNotConfiguredError);
    expect(updateJob).toHaveBeenCalledWith("job1", expect.objectContaining({ status: "FAILED" }));
    expect(enqueue).not.toHaveBeenCalledWith("publish.execute", expect.anything(), expect.anything());
  });

  it("fails after exhausting max attempts", async () => {
    const { ctx, enqueue, updateJob } = makeCtx({
      publish: async () => {
        throw new Error("still down");
      },
      job: { attempts: 2, maxAttempts: 3 }, // this is the 3rd (final) attempt
    });
    await expect(runPublish(ctx, "job1")).rejects.toThrow("still down");
    expect(updateJob).toHaveBeenCalledWith("job1", expect.objectContaining({ status: "FAILED" }));
    expect(enqueue).not.toHaveBeenCalledWith("publish.execute", expect.anything(), expect.anything());
  });
});
