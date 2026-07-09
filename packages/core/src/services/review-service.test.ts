import { describe, expect, it, vi } from "vitest";
import { ClipStatus, ReviewActionType } from "@clipfactory/db";
import { ReviewService } from "./review-service.js";

function makeRepos(clipStatus: ClipStatus) {
  const update = vi.fn().mockResolvedValue({});
  const addReviewAction = vi.fn().mockResolvedValue({});
  return {
    repos: {
      clips: {
        byId: vi.fn().mockResolvedValue({
          id: "clip1",
          status: clipStatus,
          campaign: { allowedPlatforms: ["TIKTOK"] },
        }),
        update,
        addReviewAction,
      },
    } as any,
    update,
    addReviewAction,
  };
}

describe("ReviewService.allowedActions", () => {
  it("permits all review actions when ready for review", () => {
    expect(ReviewService.allowedActions(ClipStatus.READY_FOR_REVIEW)).toContain(
      ReviewActionType.APPROVE,
    );
    expect(ReviewService.allowedActions(ClipStatus.READY_FOR_REVIEW)).toHaveLength(5);
  });

  it("permits nothing on a published clip", () => {
    expect(ReviewService.allowedActions(ClipStatus.PUBLISHED)).toEqual([]);
  });

  it("allows re-approving a rejected clip", () => {
    expect(ReviewService.allowedActions(ClipStatus.REJECTED)).toContain(ReviewActionType.APPROVE);
  });
});

describe("ReviewService.review", () => {
  it("approves a clip that is ready for review", async () => {
    const { repos, update } = makeRepos(ClipStatus.READY_FOR_REVIEW);
    const dispatcher = { enqueue: vi.fn() } as any;
    const svc = new ReviewService(repos, dispatcher);

    const result = await svc.review("clip1", "rev1", { action: ReviewActionType.APPROVE });

    expect(result.status).toBe(ClipStatus.APPROVED);
    expect(result.reprocessing).toBe(false);
    expect(update).toHaveBeenCalledWith("clip1", { status: ClipStatus.APPROVED, error: null });
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  it("re-enqueues render when regenerating", async () => {
    const { repos } = makeRepos(ClipStatus.READY_FOR_REVIEW);
    const dispatcher = { enqueue: vi.fn().mockResolvedValue(undefined) } as any;
    const svc = new ReviewService(repos, dispatcher);

    const result = await svc.review("clip1", "rev1", { action: ReviewActionType.REGENERATE });

    expect(result.reprocessing).toBe(true);
    expect(dispatcher.enqueue).toHaveBeenCalledWith(
      "clip.render",
      { clipId: "clip1" },
      { jobId: "regen-clip1" },
    );
  });

  it("rejects an illegal action for the current state", async () => {
    const { repos } = makeRepos(ClipStatus.PUBLISHED);
    const dispatcher = { enqueue: vi.fn() } as any;
    const svc = new ReviewService(repos, dispatcher);

    await expect(
      svc.review("clip1", "rev1", { action: ReviewActionType.APPROVE }),
    ).rejects.toThrow(/not allowed/);
  });
});
