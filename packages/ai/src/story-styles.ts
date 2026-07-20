/**
 * Locked visual styles for Story Studio. The anchor is appended to EVERY beat's
 * image prompt so all frames in one video share a look — the main lever for
 * cross-frame consistency (a deliberately simple style hides model drift far
 * better than photoreal). Keys are the only values the API accepts.
 */
export const STYLE_PRESETS: Record<string, string> = {
  doodle:
    "Simple black-marker stick-figure doodle on a plain off-white background. Minimal, hand-drawn, thick uneven lines, no shading, lots of empty space. Consistent childlike doodle style.",
  whiteboard:
    "Black dry-erase marker sketch on a clean white whiteboard. Simple line drawings and stick figures, a few flat accent colors, explainer-video look. Consistent whiteboard style.",
  "flat-vector":
    "Flat vector illustration, bold simple shapes, limited 4-color palette, thick outlines, no gradients, modern minimal infographic style. Consistent flat-vector style.",
  "notebook-sketch":
    "Ballpoint-pen sketch on lined notebook paper, quick loose hand-drawn doodles and stick figures, slightly messy, monochrome blue ink. Consistent notebook-sketch style.",
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
