import { z } from "zod";

export const STORY_STYLES = ["stick-scene", "doodle", "whiteboard", "flat-vector", "notebook-sketch"] as const;
export const STORY_NARRATOR_KEYS = ["storyteller", "hyped", "deadpan-documentary", "conspiratorial"] as const;
export const CAPTION_STYLE_KEYS = ["bold-center", "yellow-pop", "clean-bottom"] as const;
export const CAPTION_POSITIONS = ["top", "middle", "bottom"] as const;
export const MUSIC_MOODS = ["none", "calm", "tense", "upbeat", "epic"] as const;

/**
 * Long-form (16:9, ~8 min) vs short (9:16, ~70-90s). This is the ONE knob that
 * drives everything downstream — aspect ratio, beat count and narration length
 * are all derived from it in the service (see story-service.ts), because a
 * long-form YouTube explainer and a vertical Short are different shapes, not just
 * different durations.
 */
export const STORY_LENGTHS = ["long", "short"] as const;

/**
 * Create a generated story video. `length` picks the shape (long 16:9 vs short
 * 9:16); the AI then writes the most complete, interesting story it can within
 * that shape's word band.
 */
export const CreateStoryInputSchema = z.object({
  topic: z.string().min(3).max(300),
  length: z.enum(STORY_LENGTHS).default("long"),
  style: z.enum(STORY_STYLES).default("stick-scene"),
  /** Voice tier: standard (OpenAI) or premium (ElevenLabs). */
  voiceTier: z.enum(["standard", "premium"]).default("standard"),
  narrator: z.enum(STORY_NARRATOR_KEYS).default("storyteller"),
  category: z.string().max(60).optional(),
  captionStyle: z.enum(CAPTION_STYLE_KEYS).default("bold-center"),
  captionPosition: z.enum(CAPTION_POSITIONS).default("middle"),
  music: z.enum(MUSIC_MOODS).default("none"),
});
export type CreateStoryInput = z.infer<typeof CreateStoryInputSchema>;

export const SuggestTopicsQuerySchema = z.object({
  category: z.string().max(60).optional(),
});

export const SuggestTopicsResponseSchema = z.object({ topics: z.array(z.string()) });
