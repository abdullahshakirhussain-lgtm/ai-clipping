import { z } from "zod";
import {
  ClipStatusSchema,
  PlatformSchema,
  PublishJobStatusSchema,
  ReviewActionTypeSchema,
  SourceVideoStatusSchema,
} from "./common.js";

export const TranscriptSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z
    .array(z.object({ start: z.number(), end: z.number(), word: z.string() }))
    .optional(),
});
export type TranscriptSegmentDto = z.infer<typeof TranscriptSegmentSchema>;

export const SourceVideoDtoSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  campaignName: z.string(),
  creatorName: z.string(),
  originalUrl: z.string(),
  status: SourceVideoStatusSchema,
  title: z.string().nullable(),
  durationSec: z.number().nullable(),
  clipCount: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type SourceVideoDto = z.infer<typeof SourceVideoDtoSchema>;

export const HooksSchema = z.object({
  variants: z.array(z.string()),
  selectedIndex: z.number().int(),
});
export type Hooks = z.infer<typeof HooksSchema>;

export const ClipPublishSummarySchema = z.object({
  jobId: z.string(),
  platform: PlatformSchema,
  accountHandle: z.string(),
  status: PublishJobStatusSchema,
  externalUrl: z.string().nullable(),
});

export const ClipDtoSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  campaignName: z.string(),
  creatorName: z.string(),
  allowedPlatforms: z.array(PlatformSchema),
  sourceVideoId: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  durationSec: z.number(),
  status: ClipStatusSchema,
  previewUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  detectionReason: z.string().nullable(),
  captionStyle: z.string(),
  error: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  hashtags: z.array(z.string()),
  hooks: HooksSchema.nullable(),
  qualityScore: z.number().nullable(),
  viralScore: z.number().nullable(),
  estimatedEngagement: z.number().nullable(),
  publishJobs: z.array(ClipPublishSummarySchema),
  createdAt: z.string(),
});
export type ClipDto = z.infer<typeof ClipDtoSchema>;

export const ClipDetailDtoSchema = ClipDtoSchema.extend({
  transcriptExcerpt: z.string().nullable(),
  reviewActions: z.array(
    z.object({
      action: ReviewActionTypeSchema,
      note: z.string().nullable(),
      reviewerName: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type ClipDetailDto = z.infer<typeof ClipDetailDtoSchema>;

export const ClipListQuerySchema = z.object({
  status: ClipStatusSchema.optional(),
  campaignId: z.string().optional(),
  sourceVideoId: z.string().optional(),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});
export type ClipListQuery = z.infer<typeof ClipListQuerySchema>;

export const ClipListResponseSchema = z.object({
  items: z.array(ClipDtoSchema),
  total: z.number().int(),
});

export const ReviewInputSchema = z.object({
  action: ReviewActionTypeSchema,
  note: z.string().max(1000).optional(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
