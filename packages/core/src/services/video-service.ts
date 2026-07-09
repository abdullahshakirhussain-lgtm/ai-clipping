import type { Repositories, SourceVideoStatus } from "@clipfactory/db";
import type { SourceVideoDto, TranscriptSegmentDto } from "../contracts/index.js";
import { NotFoundError } from "../errors.js";
import { toSourceVideoDto } from "../mappers.js";

export interface SourceVideoDetail extends SourceVideoDto {
  transcript: { language: string; fullText: string; segments: TranscriptSegmentDto[] } | null;
}

export class VideoService {
  constructor(private readonly repos: Repositories) {}

  async list(filter?: { campaignId?: string; status?: SourceVideoStatus }): Promise<SourceVideoDto[]> {
    const rows = await this.repos.sourceVideos.list(filter);
    return rows.map(toSourceVideoDto);
  }

  async get(id: string): Promise<SourceVideoDetail> {
    const v = await this.repos.sourceVideos.byId(id);
    if (!v) throw new NotFoundError("SourceVideo", id);
    return {
      ...toSourceVideoDto({ ...v, _count: { clips: v.clips.length } }),
      transcript: v.transcript
        ? {
            language: v.transcript.language,
            fullText: v.transcript.fullText,
            segments: (v.transcript.segments as unknown as TranscriptSegmentDto[]) ?? [],
          }
        : null,
    };
  }
}
