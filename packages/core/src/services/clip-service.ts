import { ClipStatus, type Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { ObjectStorage } from "@clipfactory/storage";
import type {
  ClipDetailDto,
  ClipDto,
  ClipListQuery,
  CommentaryLineDto,
  TranscriptSegmentDto,
} from "../contracts/index.js";
import { NotFoundError } from "../errors.js";
import { toClipDto } from "../mappers.js";

/** Builds the transcript excerpt that falls inside a clip's window. */
export function excerptForWindow(
  segments: TranscriptSegmentDto[],
  startSec: number,
  endSec: number,
): string {
  return segments
    .filter((s) => s.end > startSec && s.start < endSec)
    .map((s) => s.text)
    .join(" ")
    .trim();
}

export class ClipService {
  constructor(
    private readonly repos: Repositories,
    private readonly storage: ObjectStorage,
    private readonly dispatcher: Dispatcher,
  ) {}

  /**
   * Replace a clip's commentary with the user's own lines and re-render it.
   *
   * `commentaryEdited` marks the script as hand-owned so the render reuses these
   * lines verbatim instead of asking the LLM again — otherwise every re-render
   * would silently throw the edit away.
   */
  async setCommentary(id: string, lines: CommentaryLineDto[]): Promise<{ clipId: string; rerendering: boolean }> {
    const clip = await this.repos.clips.byId(id);
    if (!clip) throw new NotFoundError("Clip", id);
    const edl = (clip.edl as Record<string, unknown> | null) ?? {};
    await this.repos.clips.update(id, {
      edl: { ...edl, commentary: lines, commentaryEdited: true } as never,
      status: ClipStatus.RENDERING,
      error: null,
    });
    await this.dispatcher.enqueue("clip.render", { clipId: id }, { jobId: `commentary-${id}-${Date.now()}` });
    return { clipId: id, rerendering: true };
  }

  /**
   * Move clips between voice tiers and re-render their commentary. Premium
   * (ElevenLabs) spends paid credits, so it's only ever set here — explicitly,
   * per clip — never by the pipeline on its own. Clips with commentary off just
   * store the tier for a later mode change; nothing to re-render.
   */
  async setVoiceTier(ids: string[], tier: "standard" | "premium"): Promise<{ updated: number }> {
    let updated = 0;
    for (const id of ids) {
      const clip = await this.repos.clips.byId(id);
      if (!clip || clip.voiceTier === tier) continue;
      const rerender = clip.commentaryMode !== "off";
      await this.repos.clips.update(id, {
        voiceTier: tier,
        ...(rerender ? { status: ClipStatus.RENDERING, error: null } : {}),
      });
      if (rerender) {
        await this.dispatcher.enqueue("clip.render", { clipId: id }, { jobId: `voice-${id}-${Date.now()}` });
      }
      updated++;
    }
    return { updated };
  }

  async list(query: ClipListQuery): Promise<{ items: ClipDto[]; total: number }> {
    const [rows, total] = await this.repos.clips.list(query);
    const items = await Promise.all(rows.map((c) => toClipDto(c, this.storage)));
    return { items, total };
  }

  /** Bulk grid cull: keep restores, discard hides a batch of clips. */
  async bulkCull(ids: string[], keep: boolean): Promise<{ updated: number }> {
    const res = await this.repos.clips.setKept(ids, keep);
    return { updated: res.count };
  }

  /** Reassign a batch of clips' routing category (post-render recategorize). */
  async setCategory(ids: string[], category: string): Promise<{ updated: number }> {
    const res = await this.repos.clips.setCategory(ids, category);
    return { updated: res.count };
  }

  /** Label a clip's real-world outcome (feeds score calibration). */
  async setOutcome(
    id: string,
    outcome: "FLOP" | "OK" | "HIT" | null,
  ): Promise<{ id: string; outcome: "FLOP" | "OK" | "HIT" | null }> {
    const clip = await this.repos.clips.byId(id);
    if (!clip) throw new NotFoundError("Clip", id);
    await this.repos.clips.setOutcome(id, outcome);
    return { id, outcome };
  }

  async get(id: string): Promise<ClipDetailDto> {
    const clip = await this.repos.clips.byId(id);
    if (!clip) throw new NotFoundError("Clip", id);
    const dto = await toClipDto(clip, this.storage);
    const segments = (clip.sourceVideo.transcript?.segments ?? []) as unknown as TranscriptSegmentDto[];
    return {
      ...dto,
      transcriptExcerpt: segments.length
        ? excerptForWindow(segments, clip.startSec, clip.endSec)
        : null,
      reviewActions: clip.reviewActions.map((a) => ({
        action: a.action,
        note: a.note,
        reviewerName: a.reviewer?.name ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }
}
