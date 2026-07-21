import { z } from "zod";

export const STORY_STYLES = ["doodle", "whiteboard", "flat-vector", "notebook-sketch"] as const;
export const STORY_NARRATOR_KEYS = ["storyteller", "hyped", "deadpan-documentary", "conspiratorial"] as const;
export const CAPTION_STYLE_KEYS = ["bold-center", "yellow-pop", "clean-bottom"] as const;
export const CAPTION_POSITIONS = ["top", "middle", "bottom"] as const;
export const MUSIC_MOODS = ["none", "calm", "tense", "upbeat", "epic"] as const;
export const STORY_LENGTHS = ["short", "medium", "long"] as const;

/** Length preset → rough spoken word budget + image (beat) count. */
export const LENGTH_TARGETS: Record<(typeof STORY_LENGTHS)[number], { words: number; beats: number }> = {
  short: { words: 90, beats: 8 },
  medium: { words: 180, beats: 12 },
  long: { words: 320, beats: 16 },
};

/** Create a generated story video. */
export const CreateStoryInputSchema = z.object({
  topic: z.string().min(3).max(300),
  style: z.enum(STORY_STYLES).default("doodle"),
  /** Voice tier: standard (OpenAI) or premium (ElevenLabs). */
  voiceTier: z.enum(["standard", "premium"]).default("standard"),
  narrator: z.enum(STORY_NARRATOR_KEYS).default("storyteller"),
  length: z.enum(STORY_LENGTHS).default("long"),
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
