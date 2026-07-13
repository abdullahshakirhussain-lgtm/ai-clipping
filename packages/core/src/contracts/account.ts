import { z } from "zod";
import { PlatformSchema, SocialAccountStatusSchema } from "./common.js";

const HourSchema = z.number().int().min(0).max(23);

export const SocialAccountDtoSchema = z.object({
  id: z.string(),
  platform: PlatformSchema,
  handle: z.string(),
  displayName: z.string().nullable(),
  category: z.string(),
  postsPerDay: z.number().int(),
  activeStartHour: z.number().int(),
  activeEndHour: z.number().int(),
  timezone: z.string(),
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
  category: z.string().min(1).max(60).default("general"),
  postsPerDay: z.number().int().min(1).max(96).default(10),
  activeStartHour: HourSchema.default(9),
  activeEndHour: HourSchema.default(21),
  timezone: z.string().max(60).default("UTC"),
  credentials: z.record(z.unknown()).optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInputSchema>;

export const UpdateAccountInputSchema = z.object({
  displayName: z.string().max(200).optional(),
  status: SocialAccountStatusSchema.optional(),
  category: z.string().min(1).max(60).optional(),
  postsPerDay: z.number().int().min(1).max(96).optional(),
  activeStartHour: HourSchema.optional(),
  activeEndHour: HourSchema.optional(),
  timezone: z.string().max(60).optional(),
  credentials: z.record(z.unknown()).optional(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountInputSchema>;
