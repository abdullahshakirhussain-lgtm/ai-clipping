import { z } from "zod";

const CookShotSchema = z.object({ prompt: z.string().min(1).max(4000) });

/**
 * Step 1 — plan: from a dish, an LLM writes the exhaustive, continuity-locked
 * shot prompts (cheap text). The user reviews/edits them BEFORE the expensive
 * per-clip video calls, so no tokens are wasted on a video whose prompts weren't
 * vetted.
 */
export const CookPlanRequestSchema = z.object({ dish: z.string().min(3).max(200) });
export type CookPlanRequest = z.infer<typeof CookPlanRequestSchema>;

export const CookPlanSchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
  shots: z.array(CookShotSchema),
});
export type CookPlanDto = z.infer<typeof CookPlanSchema>;

/**
 * Step 2 — generate: render the video from the shot prompts the user approved
 * (possibly edited). The prompts are authoritative; the job does not re-plan.
 */
export const CreateCookInputSchema = z.object({
  dish: z.string().min(3).max(200),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  hashtags: z.array(z.string()).max(10).optional(),
  shots: z.array(CookShotSchema).min(1).max(8),
  category: z.string().max(60).optional(),
});
export type CreateCookInput = z.infer<typeof CreateCookInputSchema>;
