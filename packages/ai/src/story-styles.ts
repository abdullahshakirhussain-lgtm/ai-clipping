/**
 * Locked visual styles for Story Studio. The anchor is appended to EVERY beat's
 * image prompt so all frames in one video share a look — the main lever for
 * cross-frame consistency (a deliberately simple style hides model drift far
 * better than photoreal). Keys are the only values the API accepts.
 */
export const STYLE_PRESETS: Record<string, string> = {
  "stick-scene":
    "Characters are strictly simple black stick figures — plain thin lines, circle heads, dot eyes, simple expressive poses; NEVER detailed, painted, or cartoon-rendered. The life comes from the SCENE around them: multiple stick figures interacting, simple background objects and props (buildings, furniture, vehicles, signs as simple line drawings), and soft colored background washes and light color shading to set mood and place. Minimal foreground, colorful lively backdrop. Consistent stick-figure scene style.",
  doodle:
    "Bright, colorful hand-drawn cartoon doodle. Expressive stick figures with clear, exaggerated facial expressions and emotions (big eyes, open mouths, eyebrows). Bold cheerful colors, thick colorful outlines, playful and lively, simple flat shapes on a soft light background. Consistent fun doodle style.",
  whiteboard:
    "Colorful whiteboard explainer drawing. Expressive stick figures and simple objects in bright marker colors (red, blue, green, orange), clear facial expressions and emotion, energetic and friendly, clean white background. Consistent colorful whiteboard style.",
  "flat-vector":
    "Vibrant flat vector illustration. Bold simple shapes, bright saturated palette, thick clean outlines, expressive characters with clear emotions, modern lively infographic look, no gradients. Consistent colorful flat-vector style.",
  "notebook-sketch":
    "Colorful pen-and-marker sketch on notebook paper. Loose hand-drawn cartoon doodles and expressive stick figures with visible emotions, pops of bright color over blue-ink linework, energetic and charming. Consistent colorful sketch style.",
};

export const DEFAULT_STYLE = "doodle";

/** Resolve a style key to its anchor, falling back to the default. */
export function styleAnchor(style: string): string {
  return STYLE_PRESETS[style] ?? STYLE_PRESETS[DEFAULT_STYLE]!;
}

/** Compose a beat's image prompt with the locked style anchor. */
export function styledImagePrompt(imagePrompt: string, style: string): string {
  return `${imagePrompt.trim()}\n\nStyle: ${styleAnchor(style)}\nVertical 9:16 composition, subject centered, no text or words in the image.`;
}
