import { z } from "zod";

const AnimShotSchema = z.object({
  /** Spoken narration for this beat — paced to fit one ~8s clip. */
  text: z.string().min(1).max(600),
  /** First frame of the clip; what holds the character design steady. */
  imagePrompt: z.string().min(1).max(4000),
  /** The continuous action that plays over the 8 seconds. */
  motionPrompt: z.string().min(1).max(4000),
});

/**
 * Step 1 — plan: topic in, an editable shot list out. Writing the story and the
 * shots is cheap text; the clips are not (~$0.40 each on Veo 3.1 Lite), so
 * nothing is generated until the shots are approved. Runs in the background and
 * is polled, like the cook and call planners.
 */
export const AnimPlanRequestSchema = z.object({
  topic: z.string().min(3).max(300),
  style: z.string().max(40).optional(),
});

export const AnimPlanSchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
  setting: z.string(),
  shots: z.array(AnimShotSchema),
});
export type AnimPlanDto = z.infer<typeof AnimPlanSchema>;

export const AnimPlanStatusSchema = z.object({
  status: z.enum(["pending", "done", "error"]),
  elapsedMs: z.number(),
  plan: AnimPlanSchema.optional(),
  error: z.string().optional(),
});

/** Step 2 — generate from the approved (possibly edited) shots. */
export const CreateAnimInputSchema = z.object({
  topic: z.string().min(3).max(300),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  hashtags: z.array(z.string()).max(10).optional(),
  setting: z.string().max(2000).optional(),
  shots: z.array(AnimShotSchema).min(1).max(12),
  style: z.string().max(40).optional(),
  narrator: z.string().max(40).optional(),
  voiceTier: z.enum(["standard", "premium"]).optional(),
  music: z.string().max(40).optional(),
  category: z.string().max(60).optional(),
  captionStyle: z.string().max(40).optional(),
  captionPosition: z.enum(["top", "middle", "bottom"]).optional(),
});
export type CreateAnimInput = z.infer<typeof CreateAnimInputSchema>;
