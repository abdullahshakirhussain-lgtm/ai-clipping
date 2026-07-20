import { z } from "zod";

export const STORY_STYLES = ["doodle", "whiteboard", "flat-vector", "notebook-sketch"] as const;

/** Create a generated story video. */
export const CreateStoryInputSchema = z.object({
  topic: z.string().min(3).max(300),
  style: z.enum(STORY_STYLES).default("doodle"),
  /** Voice tier: standard (OpenAI) or premium (ElevenLabs). */
  voiceTier: z.enum(["standard", "premium"]).default("standard"),
  targetBeats: z.number().int().min(4).max(20).default(12),
  category: z.string().max(60).optional(),
});
export type CreateStoryInput = z.infer<typeof CreateStoryInputSchema>;

export const SuggestTopicsQuerySchema = z.object({
  category: z.string().max(60).optional(),
});

export const SuggestTopicsResponseSchema = z.object({ topics: z.array(z.string()) });
