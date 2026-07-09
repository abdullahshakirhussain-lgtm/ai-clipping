import type { Platform, Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type {
  ClipAnalyticsDto,
  OverviewDto,
  RevenueDto,
  Totals,
} from "../contracts/index.js";
import { NotFoundError } from "../errors.js";

const emptyTotals = (): Totals => ({
  views: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  watchTimeSec: 0,
  revenue: 0,
});

export class AnalyticsService {
  constructor(
    private readonly repos: Repositories,
    private readonly dispatcher: Dispatcher,
  ) {}

  async overview(): Promise<OverviewDto> {
    const [clipCountsRaw, videoCounts, latest, publishedToday, queues] = await Promise.all([
      this.repos.clips.countByStatus(),
      this.repos.sourceVideos.countByStatus(),
      this.repos.metrics.latestPerJob(),
      this.repos.publish.countPublishedSince(startOfToday()),
      this.dispatcher.stats(),
    ]);

    const totals = emptyTotals();
    const platformMap = new Map<
      Platform,
      { platform: Platform; posts: number; views: number; likes: number; revenue: number }
    >();
    for (const m of latest) {
      totals.views += m.views;
      totals.likes += m.likes;
      totals.comments += m.comments;
      totals.shares += m.shares;
      totals.watchTimeSec += m.watchTimeSec;
      totals.revenue += m.revenue;
      const p =
        platformMap.get(m.platform) ??
        { platform: m.platform, posts: 0, views: 0, likes: 0, revenue: 0 };
      p.posts += 1;
      p.views += m.views;
      p.likes += m.likes;
      p.revenue += m.revenue;
      platformMap.set(m.platform, p);
    }

    const topJobs = [...latest].sort((a, b) => b.views - a.views).slice(0, 5);
    const clips = await this.repos.clips.byIds(topJobs.map((j) => j.clipId));
    const clipById = new Map(clips.map((c) => [c.id, c]));
    const publishJobs = await this.repos.publish.list({ status: "PUBLISHED" });
    const urlByJob = new Map(publishJobs.map((j) => [j.id, j.externalUrl]));

    const reviewQueueDepth =
      clipCountsRaw.find((c) => c.status === "READY_FOR_REVIEW")?._count ?? 0;

    return {
      clipCounts: clipCountsRaw.map((c) => ({ status: c.status, count: c._count })),
      videoCounts,
      publishedToday,
      reviewQueueDepth,
      totals,
      byPlatform: [...platformMap.values()],
      topClips: topJobs.map((j) => ({
        clipId: j.clipId,
        title: clipById.get(j.clipId)?.enhancement?.title ?? null,
        platform: j.platform,
        views: j.views,
        revenue: j.revenue,
        externalUrl: urlByJob.get(j.publishJobId) ?? null,
      })),
      queues,
    };
  }

  async clip(clipId: string): Promise<ClipAnalyticsDto> {
    const clip = await this.repos.clips.byId(clipId);
    if (!clip) throw new NotFoundError("Clip", clipId);
    const series = await this.repos.metrics.seriesForClip(clipId);
    return {
      clipId,
      series: series.map((s) => ({
        capturedAt: s.capturedAt.toISOString(),
        platform: s.platform,
        views: s.views,
        likes: s.likes,
        comments: s.comments,
        shares: s.shares,
        revenue: Number(s.revenue),
      })),
    };
  }

  async revenue(): Promise<RevenueDto> {
    const [latest, campaigns] = await Promise.all([
      this.repos.metrics.latestPerJob(),
      this.repos.campaigns.list(),
    ]);
    const byCampaign = new Map<
      string,
      { campaignId: string; name: string; creatorName: string; posts: number; views: number; revenue: number; ratePerMille: number }
    >();
    for (const c of campaigns) {
      byCampaign.set(c.id, {
        campaignId: c.id,
        name: c.name,
        creatorName: c.creator.name,
        posts: 0,
        views: 0,
        revenue: 0,
        ratePerMille: Number(c.revenueRatePerMille),
      });
    }
    let totalRevenue = 0;
    let totalViews = 0;
    for (const m of latest) {
      const row = byCampaign.get(m.campaignId);
      if (!row) continue;
      row.posts += 1;
      row.views += m.views;
      row.revenue += m.revenue;
      totalRevenue += m.revenue;
      totalViews += m.views;
    }
    return {
      totalRevenue,
      totalViews,
      byCampaign: [...byCampaign.values()].filter((c) => c.posts > 0),
    };
  }

  /** Enqueues a metrics sync sweep of all published jobs. */
  async triggerSync(): Promise<void> {
    await this.dispatcher.enqueue("analytics.sync", {});
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
