import { z } from "zod";
import {
  ClipOutcomeSchema,
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
  originalUrl: z.string().nullable(),
  status: SourceVideoStatusSchema,
  title: z.string().nullable(),
  durationSec: z.number().nullable(),
  clipCount: z.number().int(),
  category: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  /**
   * The render options this video was actually ingested with. Surfaced because
   * they're captured at upload time and baked in — without showing them there's
   * no way to tell whether a setting took effect.
   */
  captionStyle: z.string(),
  captionPosition: z.string(),
  reframe: z.boolean(),
  autoEnhance: z.boolean(),
  subtitlesOnly: z.boolean(),
  untouched: z.boolean(),
  commentaryMode: z.string(),
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
  estimatedEngagement: z.number().nullable(),
  // Authoritative transparent scores (computed at detection, live on the clip).
  hookScore: z.number(),
  viralScore: z.number(),
  overallScore: z.number(),
  scoreBreakdown: z.record(z.unknown()).nullable(),
  detectionSource: z.string().nullable(),
  kept: z.boolean(),
  category: z.string().nullable(),
  /** True when auto-SFX cues were applied to this clip's render. */
  hasSfx: z.boolean(),
  outcome: ClipOutcomeSchema.nullable(),
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
      reviewerName: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type ClipDetailDto = z.infer<typeof ClipDetailDtoSchema>;

export const ClipListQuerySchema = z.object({
  status: ClipStatusSchema.optional(),
  campaignId: z.string().optional(),
  sourceVideoId: z.string().optional(),
  /** Grid cull filter: only kept (true) or only discarded (false) clips. */
  kept: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  /** "score" (best first, for the grid) or "recent" (newest first). */
  sort: z.enum(["score", "recent"]).default("recent"),
  take: z.coerce.number().int().min(1).max(500).default(50),
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

export const ClipBulkInputSchema = z.object({
  ids: z.array(z.string()).min(1),
  /** keep = restore to the grid, discard = cull it. */
  action: z.enum(["keep", "discard"]),
});
export type ClipBulkInput = z.infer<typeof ClipBulkInputSchema>;

export const SetOutcomeInputSchema = z.object({ outcome: ClipOutcomeSchema.nullable() });
export type SetOutcomeInput = z.infer<typeof SetOutcomeInputSchema>;

/** Bulk reassign the routing category on clips (normalised to match routing). */
export const SetClipCategoryInputSchema = z.object({
  ids: z.array(z.string()).min(1),
  category: z.string().min(1).max(60).transform((s) => s.trim().toLowerCase()),
});
export type SetClipCategoryInput = z.infer<typeof SetClipCategoryInputSchema>;
