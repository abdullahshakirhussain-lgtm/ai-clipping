/**
 * Locked visual styles for Story Studio. The anchor is appended to EVERY beat's
 * image prompt so all frames in one video share a look — the main lever for
 * cross-frame consistency (a deliberately simple style hides model drift far
 * better than photoreal). Keys are the only values the API accepts.
 */
export const STYLE_PRESETS: Record<string, string> = {
  "stick-scene":
    "The characters are TRUE simple stick figures — plain black thin-line bodies, circle heads, single-line limbs. Each head has a SIMPLE FACE that clearly shows the emotion: dot eyes, eyebrows, and a mouth (worried, shocked, curious, smiling) — the face and whole-body pose carry the feeling, never a blank head. NEVER detailed people, NEVER realistic or fully rendered cartoon characters. Keep the SAME simple stick-figure look for every character across every frame. All the life and immersion comes from the SCENE around them: a colorful, richly detailed background with the real setting's props — buildings, streets, vehicles, furniture, signs, landscape, weather — drawn in bright flat colors with soft shading so the place is instantly recognizable. Simple expressive stick figures inside a vivid, unmistakable colorful world.",
  doodle:
    "bright colorful hand-drawn cartoon doodle; characters are simple expressive stick figures (NOT detailed people) with big emotive faces — large eyes, open mouths, eyebrows; thick bold outlines, cheerful colors, simple flat shapes, colorful background that shows the setting",
  whiteboard:
    "colorful whiteboard marker drawing; expressive stick figures and simple objects in bright markers (red, blue, green, orange), clear emotions, energetic, clean white background",
  "flat-vector":
    "vibrant flat vector illustration; bold simple shapes, bright saturated colors, thick clean outlines, expressive emotive characters, modern infographic look",
  "notebook-sketch":
    "colorful pen-and-marker sketch on notebook paper; loose hand-drawn doodles and expressive stick figures, bright color over blue-ink linework, energetic and charming",
};

export const DEFAULT_STYLE = "stick-scene";

/** Resolve a style key to its anchor, falling back to the default. */
export function styleAnchor(style: string): string {
  return STYLE_PRESETS[style] ?? STYLE_PRESETS[DEFAULT_STYLE]!;
}

/** Portrait (short/9:16) vs landscape (long-form/16:9) framing for the image. */
export type ImageOrientation = "portrait" | "landscape";

/**
 * Compose a beat's image prompt: the beat's action first, then the story's
 * shared visual world (so every frame stays on-topic and coherent), then the
 * locked style anchor and composition. `setting` is the per-story world bible
 * from the writer; empty is fine (the beat prompt still stands on its own).
 * `orientation` matches the video's aspect so the drawn composition fills the
 * frame instead of being cropped — landscape for long-form 16:9, portrait for
 * 9:16 shorts.
 */
export function styledImagePrompt(
  imagePrompt: string,
  style: string,
  setting?: string,
  orientation: ImageOrientation = "portrait",
): string {
  const world = setting && setting.trim() ? ` Setting: ${setting.trim()}.` : "";
  const frame = orientation === "landscape" ? "Horizontal 16:9 widescreen" : "Vertical 9:16";
  return `${imagePrompt.trim()}.${world} Style: ${styleAnchor(style)}. ${frame}, subject centered, no text.`;
}
