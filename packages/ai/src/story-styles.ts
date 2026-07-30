/**
 * Locked visual styles for Story Studio. The anchor is appended to EVERY beat's
 * image prompt so all frames in one video share a look — the main lever for
 * cross-frame consistency (a deliberately simple style hides model drift far
 * better than photoreal). Keys are the only values the API accepts.
 */
export const STYLE_PRESETS: Record<string, string> = {
  "stick-scene":
    "Minimalist 2D cartoon in a clean flat style. ANY people are TRUE stick figures ONLY: a plain thin black outline body, a bare circle head, single straight lines for arms and legs, stick hands — NO muscles, NO clothing detail, NO shading, NO rendered faces beyond dot eyes + eyebrows + a simple mouth showing the emotion. They must look like an xkcd / whiteboard doodle, NOT a detailed or realistic cartoon character — if a figure looks like a drawn person rather than a stick figure, it is wrong. The SCENE is the focus and must clearly and accurately show what is described — the specific place, structures, and objects (a hall of many doors, a phalanx of shields, a river valley) — but drawn SIMPLY: bold clean outlines, flat bright colors, minimal shading, no photorealism and no fussy detail. Simple stick figures inside a simple, clearly-readable colorful world.",
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
