import { z } from "zod";
import { PlatformSchema, PublishJobStatusSchema } from "./common.js";

export const PublishRequestSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1),
  scheduledAt: z.string().datetime().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const PublishJobDtoSchema = z.object({
  id: z.string(),
  clipId: z.string(),
  clipTitle: z.string().nullable(),
  campaignName: z.string(),
  platform: PlatformSchema,
  accountHandle: z.string(),
  status: PublishJobStatusSchema,
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  scheduledAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  externalUrl: z.string().nullable(),
  lastError: z.string().nullable(),
  attemptsLog: z.array(
    z.object({
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      success: z.boolean(),
      response: z.unknown().nullable(),
    }),
  ),
  createdAt: z.string(),
});
export type PublishJobDto = z.infer<typeof PublishJobDtoSchema>;

export const PublishJobListQuerySchema = z.object({
  status: PublishJobStatusSchema.optional(),
  clipId: z.string().optional(),
});
