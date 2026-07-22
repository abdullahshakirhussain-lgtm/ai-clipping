/**
 * Locked visual styles for Story Studio. The anchor is appended to EVERY beat's
 * image prompt so all frames in one video share a look — the main lever for
 * cross-frame consistency (a deliberately simple style hides model drift far
 * better than photoreal). Keys are the only values the API accepts.
 */
export const STYLE_PRESETS: Record<string, string> = {
  "stick-scene":
    "simple black stick figures — thin lines, circle heads, dot eyes, expressive poses — in a lively colored scene; several figures interacting, simple line-drawn props (buildings, furniture, vehicles, signs), soft colored background washes, minimal foreground, colorful backdrop",
  doodle:
    "bright colorful hand-drawn cartoon doodle; expressive stick figures with big emotive faces (large eyes, open mouths, eyebrows), thick bold outlines, cheerful colors, simple flat shapes, soft light background",
  whiteboard:
    "colorful whiteboard marker drawing; expressive stick figures and simple objects in bright markers (red, blue, green, orange), clear emotions, energetic, clean white background",
  "flat-vector":
    "vibrant flat vector illustration; bold simple shapes, bright saturated colors, thick clean outlines, expressive emotive characters, modern infographic look",
  "notebook-sketch":
    "colorful pen-and-marker sketch on notebook paper; loose hand-drawn doodles and expressive stick figures, bright color over blue-ink linework, energetic and charming",
};

export const DEFAULT_STYLE = "doodle";

/** Resolve a style key to its anchor, falling back to the default. */
export function styleAnchor(style: string): string {
  return STYLE_PRESETS[style] ?? STYLE_PRESETS[DEFAULT_STYLE]!;
}

/** Compose a beat's image prompt with the locked style anchor. */
export function styledImagePrompt(imagePrompt: string, style: string): string {
  return `${imagePrompt.trim()}. Style: ${styleAnchor(style)}. Vertical 9:16, subject centered, no text.`;
}
