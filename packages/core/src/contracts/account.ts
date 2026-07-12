import { z } from "zod";
import { PlatformSchema, SocialAccountStatusSchema } from "./common.js";

export const SocialAccountDtoSchema = z.object({
  id: z.string(),
  platform: PlatformSchema,
  handle: z.string(),
  displayName: z.string().nullable(),
  status: SocialAccountStatusSchema,
  publishJobCount: z.number().int(),
  hasCredentials: z.boolean(),
  createdAt: z.string(),
});
export type SocialAccountDto = z.infer<typeof SocialAccountDtoSchema>;

export const CreateAccountInputSchema = z.object({
  platform: PlatformSchema,
  handle: z.string().min(1).max(100),
  displayName: z.string().max(200).optional(),
  credentials: z.record(z.unknown()).optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInputSchema>;

export const UpdateAccountInputSchema = z.object({
  displayName: z.string().max(200).optional(),
  status: SocialAccountStatusSchema.optional(),
  credentials: z.record(z.unknown()).optional(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountInputSchema>;
