import { ClipStatus, ReviewActionType, type Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { ReviewInput } from "../contracts/index.js";
import { ConflictError, NotFoundError } from "../errors.js";

export interface ReviewResult {
  clipId: string;
  status: ClipStatus;
  /** True when the action re-enqueued a pipeline stage (regenerate/improve). */
  reprocessing: boolean;
}

/**
 * Governs the only manual step. Encodes the review state machine so the API and
 * tests share one source of truth for which actions are legal in which state.
 */
export class ReviewService {
  constructor(
    private readonly repos: Repositories,
    private readonly dispatcher: Dispatcher,
  ) {}

  /** Actions permitted from a given clip status. */
  static allowedActions(status: ClipStatus): ReviewActionType[] {
    if (status === ClipStatus.READY_FOR_REVIEW) {
      return [
        ReviewActionType.APPROVE,
        ReviewActionType.REJECT,
        ReviewActionType.REGENERATE,
        ReviewActionType.IMPROVE_HOOK,
        ReviewActionType.IMPROVE_CAPTIONS,
      ];
    }
    if (status === ClipStatus.APPROVED) {
      return [ReviewActionType.REJECT];
    }
    if (status === ClipStatus.REJECTED) {
      return [ReviewActionType.APPROVE, ReviewActionType.REGENERATE];
    }
    return [];
  }

  async review(clipId: string, reviewerId: string, input: ReviewInput): Promise<ReviewResult> {
    const clip = await this.repos.clips.byId(clipId);
    if (!clip) throw new NotFoundError("Clip", clipId);

    const allowed = ReviewService.allowedActions(clip.status);
    if (!allowed.includes(input.action)) {
      throw new ConflictError(
        `Action ${input.action} not allowed while clip is ${clip.status}`,
      );
    }

    await this.repos.clips.addReviewAction(clipId, reviewerId, input.action, input.note);

    switch (input.action) {
      case ReviewActionType.APPROVE:
        await this.repos.clips.update(clipId, { status: ClipStatus.APPROVED, error: null });
        return { clipId, status: ClipStatus.APPROVED, reprocessing: false };

      case ReviewActionType.REJECT:
        await this.repos.clips.update(clipId, { status: ClipStatus.REJECTED });
        return { clipId, status: ClipStatus.REJECTED, reprocessing: false };

      case ReviewActionType.REGENERATE:
        // Re-run render + enhance from the detected window
        await this.repos.clips.update(clipId, { status: ClipStatus.RENDERING, error: null });
        await this.dispatcher.enqueue("clip.render", { clipId }, { jobId: `regen-${clipId}` });
        return { clipId, status: ClipStatus.RENDERING, reprocessing: true };

      case ReviewActionType.IMPROVE_HOOK:
      case ReviewActionType.IMPROVE_CAPTIONS:
        // Both re-run enhancement; the stage reads the latest review note for intent
        await this.repos.clips.update(clipId, { status: ClipStatus.ENHANCING, error: null });
        await this.dispatcher.enqueue("clip.enhance", { clipId }, { jobId: `enhance-${clipId}` });
        return { clipId, status: ClipStatus.ENHANCING, reprocessing: true };

      default:
        throw new ConflictError(`Unhandled action ${input.action}`);
    }
  }
}
