import { z } from "zod";
import { PlatformSchema, SocialAccountStatusSchema } from "./common.js";

export const SocialAccountDtoSchema = z.object({
  id: z.string(),
  platform: PlatformSchema,
  handle: z.string(),
  displayName: z.string().nullable(),
  status: SocialAccountStatusSchema,
  dailyQuota: z.number().int(),
  publishJobCount: z.number().int(),
  hasCredentials: z.boolean(),
  createdAt: z.string(),
});
export type SocialAccountDto = z.infer<typeof SocialAccountDtoSchema>;

export const CreateAccountInputSchema = z.object({
  platform: PlatformSchema,
  handle: z.string().min(1).max(100),
  displayName: z.string().max(200).optional(),
  dailyQuota: z.number().int().min(1).max(200).default(20),
  credentials: z.record(z.unknown()).optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInputSchema>;

export const UpdateAccountInputSchema = z.object({
  displayName: z.string().max(200).optional(),
  status: SocialAccountStatusSchema.optional(),
  dailyQuota: z.number().int().min(1).max(200).optional(),
  credentials: z.record(z.unknown()).optional(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountInputSchema>;
