import { z } from "zod";
import { PlatformSchema, PublishJobStatusSchema } from "./common.js";

export const DistributeResultSchema = z.object({
  clipsConsidered: z.number().int(),
  jobsCreated: z.number().int(),
  byAccount: z.array(
    z.object({
      accountId: z.string(),
      handle: z.string(),
      platform: PlatformSchema,
      created: z.number().int(),
    }),
  ),
  /** Why eligible clips produced no jobs, so the UI can explain the outcome. */
  skipped: z.object({
    noCategory: z.number().int(),
    noMatchingAccount: z.number().int(),
    alreadyDistributed: z.number().int(),
  }),
});
export type DistributeResult = z.infer<typeof DistributeResultSchema>;

/** Optional scope: distribute only these clips (Library action) vs all eligible. */
export const DistributeInputSchema = z.object({
  clipIds: z.array(z.string()).optional(),
});
export type DistributeInput = z.infer<typeof DistributeInputSchema>;

/** One item on the VA work-queue: a clip to post to an account at a time. */
export const PostTaskSchema = z.object({
  jobId: z.string(),
  clipId: z.string(),
  accountId: z.string(),
  platform: PlatformSchema,
  handle: z.string(),
  category: z.string().nullable(),
  scheduledAt: z.string().nullable(),
  status: PublishJobStatusSchema,
  title: z.string().nullable(),
  description: z.string().nullable(),
  hashtags: z.array(z.string()),
  previewUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  externalUrl: z.string().nullable(),
});
export type PostTask = z.infer<typeof PostTaskSchema>;

export const DistributionOverviewSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      platform: PlatformSchema,
      handle: z.string(),
      category: z.string(),
      postsPerDay: z.number().int(),
      postedToday: z.number().int(),
      scheduledPending: z.number().int(),
    }),
  ),
  totals: z.object({
    postedToday: z.number().int(),
    scheduledPending: z.number().int(),
  }),
});
export type DistributionOverview = z.infer<typeof DistributionOverviewSchema>;

export const MarkPostedInputSchema = z.object({ url: z.string().url().max(500) });
export const RescheduleInputSchema = z.object({ scheduledAt: z.string().datetime() });
