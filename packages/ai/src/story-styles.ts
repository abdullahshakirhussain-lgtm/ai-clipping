import { STYLE_REFS } from "./style-refs.generated.js";

/**
 * Locked visual styles for Story Studio. The anchor is appended to EVERY beat's
 * image prompt so all frames in one video share a look — the main lever for
 * cross-frame consistency (a deliberately simple style hides model drift far
 * better than photoreal). Keys are the only values the API accepts.
 */
export const STYLE_PRESETS: Record<string, string> = {
  "stick-scene":
    "Minimalist 2D cartoon in a clean flat style. ANY people are TRUE stick figures ONLY: a plain thin black outline body, a bare circle head, single straight lines for arms and legs, stick hands — NO muscles, NO clothing detail, NO shading, NO rendered faces beyond dot eyes + eyebrows + a simple mouth showing the emotion. They must look like an xkcd / whiteboard doodle, NOT a detailed or realistic cartoon character — if a figure looks like a drawn person rather than a stick figure, it is wrong. The SCENE is the focus and must clearly and accurately show what is described — the specific place, structures, and objects (a hall of many doors, a phalanx of shields, a river valley) — but drawn SIMPLY: bold clean outlines, flat bright colors, minimal shading, no photorealism and no fussy detail. Simple stick figures inside a simple, clearly-readable colorful world.",
  explainer:
    "Clean flat 2D vector EXPLAINER graphic, like a modern stick-figure history channel. Bold black outlines, flat bright colors, minimal shading, a plain white or single flat-color background. The picture is the SIMPLEST clear graphic for the idea: a bold ICON for an object (fire, spear, pot, lightbulb, DNA strand); a clean LABELLED DIAGRAM for a fact, number, comparison or process (a timeline, a before/after, a cross-section, a bar chart, a map, a family tree, a two-column comparison); a simple VISUAL METAPHOR for an abstract idea (a brick wall shattering = a barrier broken; a glowing star passing from one head to another = an idea shared); and a TRUE simple stick figure (circle head, single-line limbs, dot-eyes-and-mouth face showing the feeling) ONLY when the beat is about a person. Small RED accents — arrows, circles, X marks, highlights — point the eye at what matters. Never a detailed or realistic scene; think whiteboard-clear, not painterly.",
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

/**
 * Fixed style-reference exemplar for a style, as a Buffer — fed to gpt-image's
 * edits endpoint so the look is enforced by EXAMPLE, not a text description
 * (which mini collapses). Null when no exemplar has been generated for the style
 * yet; the caller then falls back to the text anchor. See style-refs.generated.ts
 * and scripts/gen-style-exemplars.ts.
 */
export function styleRefBuffer(style: string): Buffer | null {
  const b64 = STYLE_REFS[style];
  return b64 ? Buffer.from(b64, "base64") : null;
}

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
  hasStyleRef = false,
): string {
  const world = setting && setting.trim() ? ` Setting: ${setting.trim()}.` : "";
  const frame = orientation === "landscape" ? "Horizontal 16:9 widescreen" : "Vertical 9:16";
  // When a style-reference image is attached (edits endpoint), tell the model to
  // copy the reference's LOOK but not its content — otherwise it edits the
  // exemplar instead of drawing the new subject.
  const refLine = hasStyleRef
    ? " Match the ART STYLE of the reference image exactly — its line work, colour palette and level of detail — but draw the NEW subject described above; do NOT reuse the reference's content, characters or composition."
    : "";
  // ONE single picture per image. The image model otherwise sometimes returns a
  // collage / triptych / comic strip — several small panels, some clipped by the
  // frame edge ("spilling out"). Forbid that outright.
  return `${imagePrompt.trim()}.${world} Style: ${styleAnchor(style)}.${refLine} ${frame}, subject centered, no text. ONE single picture — a SINGLE composition with one main subject, fully inside the frame. NO panels, NO split-screen, NO collage, NO grid or strip of multiple images, nothing clipped or spilling past the edges.`;
}
