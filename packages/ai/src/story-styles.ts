/**
 * Locked visual styles for Story Studio. Two paths only:
 *  - "stick-openai" (default): the working OpenAI text-to-image look — a simple
 *    stick figure with a WHITE head + emotive face + stick limbs (a dress/clothes
 *    on the body is fine) inside a colourful, accurate scene. The anchor is
 *    appended to EVERY beat prompt so all frames share a look.
 *  - "stick-fal": the experimental fal composite path — the figure is drawn
 *    deterministically and pasted on, so this anchor describes the BACKGROUND only
 *    (no people); the scene is generated with a clear foreground for the figure.
 */
export const STYLE_PRESETS: Record<string, string> = {
  "stick-openai":
    "Minimalist flat 2D cartoon. The character(s) are simple STICK FIGURES: a plain WHITE round head with a simple expressive face (dot eyes, eyebrows and a curved mouth clearly showing the emotion), and thin single-line stick arms and legs. A simple dress or plain clothes on the body is fine — do NOT force a bare body — but the HEAD stays a white circle with a face and the visible ARMS and LEGS stay thin stick lines, never realistic or muscled limbs. Keep every figure simple and doodle-like (xkcd-ish), never a detailed or realistic cartoon person. The SCENE around them is an accurate, clearly-readable COLOURFUL world showing the specific place, objects and structures described — bold clean outlines, flat bright colours, light shading, no photorealism and no fussy detail. PALETTE: keep it WARM, VIVID and SATURATED throughout — a cheerful storybook look. Even dark, cold, night, dusk or underground scenes are lit WARMLY (glowing amber lamplight, firelight, warm moonlight, a bright sky) and stay colourful and inviting — NEVER grey, brown-muddy, drab, desaturated, washed-out, bleak or gloomy. Historically accurate but always bright and appealing to look at.",
  "stick-fal":
    "Flat 2D colourful children's history-explainer cartoon BACKGROUND: draw the specific place, objects and structures described with bold clean outlines, flat bright colours and light shading. PALETTE: warm, vivid and saturated — a cheerful storybook look; even dark, night or underground scenes are lit warmly (amber lamplight, firelight, warm moonlight) and stay colourful, never grey, muddy, drab or gloomy. Leave a wide, clear, mostly-empty foreground with open ground. NO people, no characters, no figures of any kind — the character is added separately.",
};

export const DEFAULT_STYLE = "stick-openai";

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
  // ONE single picture per image. The image model otherwise sometimes returns a
  // collage / triptych / comic strip — several small panels, some clipped by the
  // frame edge ("spilling out"). Forbid that outright.
  return `${imagePrompt.trim()}.${world} Style: ${styleAnchor(style)} ${frame}, subject centered, no text. ONE single picture — a SINGLE composition with one main subject, fully inside the frame. NO panels, NO split-screen, NO collage, NO grid or strip of multiple images, nothing clipped or spilling past the edges.`;
}
