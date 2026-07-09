import { z } from "zod";
import { CampaignStatusSchema, PlatformSchema, SourcePlatformSchema } from "./common.js";

export const CreatorDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string(),
  notes: z.string().nullable(),
  campaignCount: z.number().int(),
});
export type CreatorDto = z.infer<typeof CreatorDtoSchema>;

export const CampaignDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  creator: z.object({ id: z.string(), name: z.string(), handle: z.string() }),
  sourceVideoUrl: z.string(),
  sourcePlatform: SourcePlatformSchema,
  allowedPlatforms: z.array(PlatformSchema),
  revenueRatePerMille: z.number(),
  rules: z.record(z.unknown()).nullable(),
  expiresAt: z.string().nullable(),
  status: CampaignStatusSchema,
  sourceVideoCount: z.number().int(),
  clipCount: z.number().int(),
  createdAt: z.string(),
});
export type CampaignDto = z.infer<typeof CampaignDtoSchema>;

export const CreateCampaignInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    sourceVideoUrl: z.string().url(),
    sourcePlatform: SourcePlatformSchema.default("YOUTUBE"),
    allowedPlatforms: z.array(PlatformSchema).min(1),
    revenueRatePerMille: z.number().min(0).default(0),
    rules: z.record(z.unknown()).optional(),
    expiresAt: z.string().datetime().optional(),
    creatorId: z.string().optional(),
    creator: z.object({ name: z.string().min(1), handle: z.string().min(1) }).optional(),
    /** When true the campaign is created ACTIVE and ingestion starts immediately. */
    ingestNow: z.boolean().default(false),
  })
  .refine((v) => v.creatorId || v.creator, {
    message: "Either creatorId or creator must be provided",
  });
export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>;

export const UpdateCampaignInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: CampaignStatusSchema.optional(),
  allowedPlatforms: z.array(PlatformSchema).min(1).optional(),
  revenueRatePerMille: z.number().min(0).optional(),
  rules: z.record(z.unknown()).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignInputSchema>;
