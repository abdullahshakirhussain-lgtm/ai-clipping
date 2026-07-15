import { z } from "zod";
import { PlatformSchema, SocialAccountStatusSchema } from "./common.js";

const HourSchema = z.number().int().min(0).max(23);

export const SocialAccountDtoSchema = z.object({
  id: z.string(),
  platform: PlatformSchema,
  handle: z.string(),
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  /** True when an encrypted password is stored (the value itself is never listed). */
  hasPassword: z.boolean(),
  category: z.string(),
  channelId: z.string().nullable(),
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
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  category: z.string().min(1).max(60).default("general"),
  channelId: z.string().max(120).optional(),
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
  username: z.string().max(200).optional(),
  /** New password to store (encrypted). Empty string clears it; omit to keep. */
  password: z.string().max(500).optional(),
  category: z.string().min(1).max(60).optional(),
  channelId: z.string().max(120).optional(),
  postsPerDay: z.number().int().min(1).max(96).optional(),
  activeStartHour: HourSchema.optional(),
  activeEndHour: HourSchema.optional(),
  timezone: z.string().max(60).optional(),
  credentials: z.record(z.unknown()).optional(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountInputSchema>;
