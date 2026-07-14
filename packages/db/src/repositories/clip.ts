import type { ClipOutcome, ClipStatus, PrismaClient, Prisma, ReviewActionType } from "@prisma/client";

const detailInclude = {
  enhancement: true,
  sourceVideo: { include: { transcript: true } },
  campaign: true,
  reviewActions: { orderBy: { createdAt: "desc" as const }, include: { reviewer: true } },
  publishJobs: { include: { socialAccount: true } },
} satisfies Prisma.ClipInclude;

export type ClipDetail = Prisma.ClipGetPayload<{ include: typeof detailInclude }>;

export class ClipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  createMany(rows: Prisma.ClipUncheckedCreateInput[]) {
    return this.prisma.$transaction(rows.map((data) => this.prisma.clip.create({ data })));
  }

  byId(id: string): Promise<ClipDetail | null> {
    return this.prisma.clip.findUnique({ where: { id }, include: detailInclude });
  }

  list(filter?: {
    status?: ClipStatus | ClipStatus[];
    campaignId?: string;
    sourceVideoId?: string;
    kept?: boolean;
    sort?: "score" | "recent";
    take?: number;
    skip?: number;
  }) {
    const where: Prisma.ClipWhereInput = {
      status: Array.isArray(filter?.status) ? { in: filter.status } : filter?.status,
      campaignId: filter?.campaignId,
      sourceVideoId: filter?.sourceVideoId,
      kept: filter?.kept,
    };
    // A stable secondary key (id) is essential: without it, rows tied on the
    // primary key (integer scores tie constantly) come back in arbitrary
    // physical order that changes between fetches, so the grid reshuffles on
    // every SWR refresh.
    const orderBy: Prisma.ClipOrderByWithRelationInput[] =
      filter?.sort === "score"
        ? [{ overallScore: "desc" }, { id: "asc" }]
        : [{ createdAt: "desc" }, { id: "asc" }];
    return this.prisma.$transaction([
      this.prisma.clip.findMany({
        where,
        include: {
          enhancement: true,
          campaign: true,
          publishJobs: { include: { socialAccount: true } },
        },
        orderBy,
        take: filter?.take ?? 50,
        skip: filter?.skip ?? 0,
      }),
      this.prisma.clip.count({ where }),
    ]);
  }

  /** Bulk cull flag toggle used by the grid. */
  setKept(ids: string[], kept: boolean) {
    return this.prisma.clip.updateMany({ where: { id: { in: ids } }, data: { kept } });
  }

  /** Reassign the routing category on a batch of clips (grid recategorize). */
  setCategory(ids: string[], category: string) {
    return this.prisma.clip.updateMany({ where: { id: { in: ids } }, data: { category } });
  }

  /** Label a clip's real-world outcome (feeds score calibration). */
  setOutcome(id: string, outcome: ClipOutcome | null) {
    return this.prisma.clip.update({ where: { id }, data: { outcome } });
  }

  /** Kept + approved clips that have a category, with existing target-account ids. */
  /**
   * Kept + approved clips eligible for distribution, with their existing target
   * accounts. Category may be null here so the caller can report "no category"
   * as a skip reason. Optionally scoped to specific clip ids (Library action).
   */
  distributable(clipIds?: string[]) {
    return this.prisma.clip.findMany({
      where: {
        kept: true,
        status: "APPROVED",
        ...(clipIds && clipIds.length ? { id: { in: clipIds } } : {}),
      },
      include: {
        publishJobs: { select: { socialAccountId: true } },
      },
    });
  }

  /** All outcome-labeled clips with their stored score breakdown, for calibration. */
  labeledForCalibration(): Promise<Array<{ scoreBreakdown: Prisma.JsonValue; outcome: ClipOutcome | null }>> {
    return this.prisma.clip.findMany({
      where: { outcome: { not: null } },
      select: { scoreBreakdown: true, outcome: true },
    });
  }

  update(id: string, data: Prisma.ClipUncheckedUpdateInput) {
    return this.prisma.clip.update({ where: { id }, data });
  }

  /** Guarded status transition: returns false when the clip was not in `from`. */
  async transition(id: string, from: ClipStatus[], to: ClipStatus) {
    const result = await this.prisma.clip.updateMany({
      where: { id, status: { in: from } },
      data: { status: to },
    });
    return result.count === 1;
  }

  upsertEnhancement(
    clipId: string,
    data: {
      title: string;
      description: string;
      hashtags: string[];
      hooks: Prisma.InputJsonValue;
      qualityScore: number;
      viralScore: number;
      estimatedEngagement: number;
      model: string;
      promptVersion?: string;
    },
  ) {
    return this.prisma.clipEnhancement.upsert({
      where: { clipId },
      create: { clipId, ...data },
      update: data,
    });
  }

  addReviewAction(clipId: string, reviewerId: string, action: ReviewActionType, note?: string) {
    return this.prisma.reviewAction.create({
      data: { clipId, reviewerId, action, note },
    });
  }

  byIds(ids: string[]) {
    return this.prisma.clip.findMany({
      where: { id: { in: ids } },
      include: { enhancement: true, campaign: true },
    });
  }

  countByStatus(): Promise<Array<{ status: ClipStatus; _count: number }>> {
    return this.prisma.clip
      .groupBy({ by: ["status"], _count: true })
      .then((rows) => rows.map((r) => ({ status: r.status, _count: r._count })));
  }
}
