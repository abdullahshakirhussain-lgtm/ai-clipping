import { z } from "zod";

/**
 * Create a generated "cook-in-the-wild" video. The dish is the whole input; the
 * shot list, style bible and pacing are planned by the LLM (an exhaustive,
 * continuity-locked spec) and rendered as real clips with native audio.
 */
export const CreateCookInputSchema = z.object({
  dish: z.string().min(3).max(200),
  category: z.string().max(60).optional(),
});
export type CreateCookInput = z.infer<typeof CreateCookInputSchema>;
