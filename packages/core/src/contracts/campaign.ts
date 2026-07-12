import { z } from "zod";
import { CampaignStatusSchema, PlatformSchema, SourcePlatformSchema } from "./common.js";

export const CampaignDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceVideoUrl: z.string().nullable(),
  sourcePlatform: SourcePlatformSchema,
  allowedPlatforms: z.array(PlatformSchema),
  rules: z.record(z.unknown()).nullable(),
  expiresAt: z.string().nullable(),
  status: CampaignStatusSchema,
  sourceVideoCount: z.number().int(),
  clipCount: z.number().int(),
  createdAt: z.string(),
});
export type CampaignDto = z.infer<typeof CampaignDtoSchema>;

export const CreateCampaignInputSchema = z.object({
  name: z.string().min(1).max(200),
  /** Optional: only for URL/yt-dlp ingest. Upload-only projects omit it. */
  sourceVideoUrl: z.string().url().optional(),
  sourcePlatform: SourcePlatformSchema.default("YOUTUBE"),
  allowedPlatforms: z.array(PlatformSchema).min(1),
  rules: z.record(z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
  /** When true the campaign is created ACTIVE and ingestion starts immediately. */
  ingestNow: z.boolean().default(false),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>;

export const UpdateCampaignInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: CampaignStatusSchema.optional(),
  allowedPlatforms: z.array(PlatformSchema).min(1).optional(),
  rules: z.record(z.unknown()).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignInputSchema>;
