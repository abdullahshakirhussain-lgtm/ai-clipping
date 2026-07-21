import { z } from "zod";

export const STORY_STYLES = ["doodle", "whiteboard", "flat-vector", "notebook-sketch"] as const;
export const STORY_NARRATOR_KEYS = ["storyteller", "hyped", "deadpan-documentary", "conspiratorial"] as const;
export const CAPTION_STYLE_KEYS = ["bold-center", "yellow-pop", "clean-bottom"] as const;
export const CAPTION_POSITIONS = ["top", "middle", "bottom"] as const;
export const MUSIC_MOODS = ["none", "calm", "tense", "upbeat", "epic"] as const;

/** Create a generated story video. */
export const CreateStoryInputSchema = z.object({
  topic: z.string().min(3).max(300),
  style: z.enum(STORY_STYLES).default("doodle"),
  /** Voice tier: standard (OpenAI) or premium (ElevenLabs). */
  voiceTier: z.enum(["standard", "premium"]).default("standard"),
  narrator: z.enum(STORY_NARRATOR_KEYS).default("storyteller"),
  targetBeats: z.number().int().min(4).max(20).default(12),
  category: z.string().max(60).optional(),
  captionStyle: z.enum(CAPTION_STYLE_KEYS).default("bold-center"),
  captionPosition: z.enum(CAPTION_POSITIONS).default("middle"),
  music: z.enum(MUSIC_MOODS).default("none"),
  motion: z.boolean().default(false),
});
export type CreateStoryInput = z.infer<typeof CreateStoryInputSchema>;

export const SuggestTopicsQuerySchema = z.object({
  category: z.string().max(60).optional(),
});

export const SuggestTopicsResponseSchema = z.object({ topics: z.array(z.string()) });
