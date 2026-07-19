import type { DiscoveredVideoStatus, Prisma, PrismaClient } from "@prisma/client";

/** Fields captured from a source feed candidate, before scoring. */
export interface DiscoveredUpsertInput {
  platform: string;
  externalId: string;
  url: string;
  permalink: string;
  title: string;
  thumbnailUrl?: string | null;
  author?: string | null;
  source: string;
  mediaType: string;
  sourceCreatedAt: Date;
  score: number;
  comments: number;
}

export class DiscoveredVideoRepository {
  constructor(private readonly prisma: PrismaClient) {}

  byId(id: string) {
    return this.prisma.discoveredVideo.findUnique({ where: { id } });
  }

  /** Existing row for a candidate, so the caller can preserve firstSeen* + peak. */
  byExternal(platform: string, externalId: string) {
    return this.prisma.discoveredVideo.findUnique({
      where: { platform_externalId: { platform, externalId } },
    });
  }

  /**
   * Insert-or-update a candidate. On first sight, firstSeen* seed from the
   * current metric; on later polls the caller passes the recomputed velocity and
   * peakScore and we only bump the live fields (never rewind firstSeen*).
   */
  upsert(
    input: DiscoveredUpsertInput,
    computed: { velocity: number; peakScore: number },
    now: Date,
  ) {
    return this.prisma.discoveredVideo.upsert({
      where: { platform_externalId: { platform: input.platform, externalId: input.externalId } },
      create: {
        ...input,
        firstSeenAt: now,
        firstSeenScore: input.score,
        peakScore: computed.peakScore,
        lastPolledAt: now,
        velocity: computed.velocity,
      },
      update: {
        url: input.url,
        title: input.title,
        thumbnailUrl: input.thumbnailUrl ?? null,
        score: input.score,
        comments: input.comments,
        peakScore: computed.peakScore,
        lastPolledAt: now,
        velocity: computed.velocity,
      },
    });
  }

  /** Ranked feed for a status (NEW by default), hottest first. */
  list(status: DiscoveredVideoStatus, take = 100) {
    return this.prisma.discoveredVideo.findMany({
      where: { status },
      orderBy: [{ velocity: "desc" }, { id: "asc" }],
      take,
    });
  }

  setStatus(id: string, status: DiscoveredVideoStatus, ingestedVideoId?: string) {
    const data: Prisma.DiscoveredVideoUpdateInput = { status };
    if (ingestedVideoId !== undefined) data.ingestedVideoId = ingestedVideoId;
    return this.prisma.discoveredVideo.update({ where: { id }, data });
  }

  /** External ids already ingested — so the poll can skip re-surfacing them. */
  async ingestedExternalIds(platform: string): Promise<Set<string>> {
    const rows = await this.prisma.discoveredVideo.findMany({
      where: { platform, status: "INGESTED" },
      select: { externalId: true },
    });
    return new Set(rows.map((r) => r.externalId));
  }
}
