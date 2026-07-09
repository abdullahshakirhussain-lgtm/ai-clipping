import type { Platform, PrismaClient, Prisma } from "@prisma/client";

/** Latest metric snapshot per publish job, with Decimal columns coerced to number. */
export interface LatestMetric {
  publishJobId: string;
  clipId: string;
  campaignId: string;
  platform: Platform;
  capturedAt: Date;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  watchTimeSec: number;
  revenue: number;
  rpm: number;
}

export class MetricsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  record(data: Prisma.ClipMetricUncheckedCreateInput) {
    return this.prisma.clipMetric.create({ data });
  }

  seriesForClip(clipId: string) {
    return this.prisma.clipMetric.findMany({
      where: { clipId },
      orderBy: { capturedAt: "asc" },
    });
  }

  /**
   * Latest snapshot per publish job (Postgres DISTINCT ON). At MVP scale the
   * aggregation happens in the service layer; move to materialized rollups
   * when job count grows.
   */
  async latestPerJob(filter?: { campaignId?: string }): Promise<LatestMetric[]> {
    const rows = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT DISTINCT ON ("publishJobId") "publishJobId", "clipId", "campaignId", "platform", "capturedAt", "views", "likes", "comments", "shares", "watchTimeSec", "revenue", "rpm"
      FROM "ClipMetric"
      WHERE (${filter?.campaignId ?? null}::text IS NULL OR "campaignId" = ${filter?.campaignId ?? null})
      ORDER BY "publishJobId", "capturedAt" DESC`;
    return rows.map((r) => ({
      publishJobId: String(r.publishJobId),
      clipId: String(r.clipId),
      campaignId: String(r.campaignId),
      platform: r.platform as Platform,
      capturedAt: r.capturedAt as Date,
      views: Number(r.views),
      likes: Number(r.likes),
      comments: Number(r.comments),
      shares: Number(r.shares),
      watchTimeSec: Number(r.watchTimeSec),
      revenue: Number(r.revenue),
      rpm: Number(r.rpm),
    }));
  }

  upsertFeature(clipId: string, data: Omit<Prisma.ClipFeatureUncheckedCreateInput, "clipId">) {
    return this.prisma.clipFeature.upsert({
      where: { clipId },
      create: { clipId, ...data },
      update: data,
    });
  }

  listFeatures() {
    return this.prisma.clipFeature.findMany({ orderBy: { views: "desc" }, take: 200 });
  }
}
