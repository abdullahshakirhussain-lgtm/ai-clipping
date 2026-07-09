import { z } from "zod";
import { ClipStatusSchema, PlatformSchema, SourceVideoStatusSchema } from "./common.js";

export const TotalsSchema = z.object({
  views: z.number(),
  likes: z.number(),
  comments: z.number(),
  shares: z.number(),
  watchTimeSec: z.number(),
  revenue: z.number(),
});
export type Totals = z.infer<typeof TotalsSchema>;

export const QueueStatsSchema = z.array(
  z.object({
    queue: z.string(),
    waiting: z.number(),
    active: z.number(),
    failed: z.number(),
  }),
);

export const OverviewDtoSchema = z.object({
  clipCounts: z.array(z.object({ status: ClipStatusSchema, count: z.number().int() })),
  videoCounts: z.array(z.object({ status: SourceVideoStatusSchema, count: z.number().int() })),
  publishedToday: z.number().int(),
  reviewQueueDepth: z.number().int(),
  totals: TotalsSchema,
  byPlatform: z.array(
    z.object({
      platform: PlatformSchema,
      posts: z.number().int(),
      views: z.number(),
      likes: z.number(),
      revenue: z.number(),
    }),
  ),
  topClips: z.array(
    z.object({
      clipId: z.string(),
      title: z.string().nullable(),
      platform: PlatformSchema,
      views: z.number(),
      revenue: z.number(),
      externalUrl: z.string().nullable(),
    }),
  ),
  queues: QueueStatsSchema,
});
export type OverviewDto = z.infer<typeof OverviewDtoSchema>;

export const ClipAnalyticsDtoSchema = z.object({
  clipId: z.string(),
  series: z.array(
    z.object({
      capturedAt: z.string(),
      platform: PlatformSchema,
      views: z.number(),
      likes: z.number(),
      comments: z.number(),
      shares: z.number(),
      revenue: z.number(),
    }),
  ),
});
export type ClipAnalyticsDto = z.infer<typeof ClipAnalyticsDtoSchema>;

export const RevenueDtoSchema = z.object({
  totalRevenue: z.number(),
  totalViews: z.number(),
  byCampaign: z.array(
    z.object({
      campaignId: z.string(),
      name: z.string(),
      creatorName: z.string(),
      posts: z.number().int(),
      views: z.number(),
      revenue: z.number(),
      ratePerMille: z.number(),
    }),
  ),
});
export type RevenueDto = z.infer<typeof RevenueDtoSchema>;
