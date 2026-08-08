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
    "Minimalist flat 2D cartoon. The character(s) are simple STICK FIGURES: a plain WHITE round head with a simple expressive face (dot eyes, eyebrows and a curved mouth) — DEFAULT to a warm, friendly, content SMILE (a happy, at-ease look); only use another expression when the moment clearly calls for it — and thin single-line stick arms and legs. A simple dress or plain clothes on the body is fine — do NOT force a bare body — but the HEAD stays a white circle with a face and the visible ARMS and LEGS stay thin stick lines, never realistic or muscled limbs. Keep every figure simple and doodle-like (xkcd-ish), never a detailed or realistic cartoon person. COMPOSITION: frame it a little WIDE — the figure is fairly small, taking up only about the lower third to half of the frame, standing in the scene rather than filling it, so plenty of the world shows around and above them. The BACKGROUND fills most of the picture. Do NOT zoom in so the character dominates. The SCENE around them is an accurate, clearly-readable COLOURFUL world showing the specific place, objects and structures described — bold clean outlines, flat bright colours, light shading, no photorealism and no fussy detail. PALETTE: bright, clean and COLOURFUL — a cheerful storybook look using the FULL range of colour (fresh greens, sky blues, clear reds, clean whites), like a bright clear day. CRITICAL: NO yellow/amber/orange/sepia wash or tint over the whole picture — that muddy yellow overlay looks AI-made and cheap; every scene is lit cleanly and naturally for its time of day (cool bright morning, full neutral daylight, gentle evening), with true, varied colours. Stay saturated and inviting, NEVER grey, muddy, drab, desaturated, bleak or gloomy — but equally NEVER uniformly yellow-tinted. Crisp, clear and appealing to look at.",
  "hero-painterly":
    "Soft painterly STORYBOOK illustration — a warm, hand-painted look with gentle brushwork, soft natural light and rich, cosy detail, like a beautiful modern children's picture book. Show the MAN (already described at the start of the prompt) doing the specific thing described, with a warm, content, mostly-smiling look. The world around him is a colourful, FILLED, gently UTOPIAN version of the scene — lush, clean, idyllic and welcoming, full of life, plants and colour, nothing bleak or run-down. COMPOSITION: frame it a little WIDE — the man takes up only about the lower third to half of the frame and stands IN the scene, so plenty of the beautiful world shows around and above him; the background fills most of the picture, do NOT zoom in on him. PALETTE: bright, clean and COLOURFUL across the full range (fresh greens, sky blues, clear reds, warm skin tones), lit naturally for the time of day — NO yellow/amber/sepia wash or tint over the whole picture; never grey, muddy or drab. Painterly and soft, but clear and appealing.",
  "stick-fal":
    "Flat 2D colourful children's history-explainer cartoon BACKGROUND: draw the specific place, objects and structures described with bold clean outlines, flat bright colours and light shading. PALETTE: bright, clean and colourful using the FULL range of colour (greens, blues, reds, whites), lit naturally for the time of day — NO yellow/amber/sepia wash or tint over the whole picture (that muddy overlay looks AI-made); never grey, muddy, drab or gloomy, and never uniformly yellow-tinted. Leave a wide, clear, mostly-empty foreground with open ground. NO people, no characters, no figures of any kind — the character is added separately.",
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
