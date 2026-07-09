import type { Repositories } from "@clipfactory/db";
import type { ObjectStorage } from "@clipfactory/storage";
import type { ClipDetailDto, ClipDto, ClipListQuery, TranscriptSegmentDto } from "../contracts/index.js";
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
  ) {}

  async list(query: ClipListQuery): Promise<{ items: ClipDto[]; total: number }> {
    const [rows, total] = await this.repos.clips.list(query);
    const items = await Promise.all(rows.map((c) => toClipDto(c, this.storage)));
    return { items, total };
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
        reviewerName: a.reviewer.name,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }
}
