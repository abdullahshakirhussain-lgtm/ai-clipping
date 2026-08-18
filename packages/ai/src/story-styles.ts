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
    "A simple flat CARTOON STICK FIGURE character set inside a RICHLY DETAILED, ILLUSTRATED environment — the deliberate contrast (a minimalist stick figure living in a detailed, real-feeling but still ILLUSTRATED world) IS the whole style. THE FIGURE stays a minimalist doodle: a plain WHITE round head with a simple expressive face (dot eyes, eyebrows and a curved mouth) — DEFAULT to a warm, friendly, content SMILE — but an EXPLICIT action or feeling in the prompt ALWAYS overrides this default: if the prompt says the figure is asleep, draw him lying down with eyes closed; if crying, draw tears; if reaching, sitting, kneeling, so draw it. Draw the STATED pose and expression, never a generic standing smile on top of it. Thin single-line stick arms and legs; a simple dress or plain clothes on the body is fine, but the HEAD stays a white circle with a face and the visible ARMS and LEGS stay thin stick lines — never realistic or muscled limbs, never a detailed human. Keep the figure flat, clean and doodle-like (xkcd-ish) EVEN THOUGH the world around it is realistic. THE WORLD / BACKGROUND, by contrast, is a DETAILED, PAINTERLY ILLUSTRATION with DENSE DETAIL: a believable, richly rendered environment with real depth, materials and textures, natural lighting and soft shadow, and layered foreground/middle/distance — like a beautifully detailed illustrated / animated-film background, NOT a photograph. Keep the SAME illustrated finish and the SAME level of detail for EXTERIORS as for interiors — outdoor scenes (sky, fields, streets, water) stay illustrated at that level and are NEVER pushed to photoreal — so the flat stick figure always sits naturally in the world and never looks pasted onto a photo. Packed with the specific props, structures, plants and surroundings the scene describes; never a flat, bare or cartoonish backdrop — the rich detail lives ENTIRELY in the WORLD, the flat simplicity ENTIRELY in the FIGURE. COMPOSITION: frame it a little WIDE — the figure is fairly small, taking up only about the lower third to half of the frame, PLACED within the scene in WHATEVER POSE the moment calls for (standing, sitting, kneeling, crouching, walking, lying down — match the prompt, do NOT default to standing), so the detailed world fills most of the picture around and above it; do NOT zoom in so the figure dominates. PALETTE: bright, clean and COLOURFUL using the FULL range of colour (fresh greens, sky blues, clear reds, clean whites), lit naturally for the time of day. CRITICAL: NO yellow/amber/orange/sepia wash or tint over the whole picture — that muddy overlay looks AI-made and cheap; light each scene cleanly and naturally (cool bright morning, full neutral daylight, gentle evening) with true, varied colours. Never grey, muddy, drab, desaturated, bleak or gloomy, and never uniformly yellow-tinted. Crisp, detailed and appealing to look at.",
  "hero-painterly":
    "Soft painterly STORYBOOK illustration — a warm, hand-painted look with gentle brushwork, soft natural light and rich, cosy detail, like a beautiful modern children's picture book. Show the MAN (already described at the start of the prompt) doing the specific thing described, in whatever POSE the moment calls for (sitting, kneeling, walking, lying down asleep, etc. — match the prompt, do NOT default to standing), with a warm, content, mostly-smiling look UNLESS the prompt states another action or feeling (asleep = lying with eyes closed, etc.), which always wins. The world around him is a colourful, FILLED, gently UTOPIAN version of the scene — lush, clean, idyllic and welcoming, full of life, plants and colour, nothing bleak or run-down. COMPOSITION: frame it a little WIDE — the man takes up only about the lower third to half of the frame and is IN the scene in the pose the moment calls for (not always standing), so plenty of the beautiful world shows around and above him; the background fills most of the picture, do NOT zoom in on him. PALETTE: bright, clean and COLOURFUL across the full range (fresh greens, sky blues, clear reds, warm skin tones), lit naturally for the time of day — NO yellow/amber/sepia wash or tint over the whole picture; never grey, muddy or drab. Painterly and soft, but clear and appealing.",
  "anime-fpv":
    "Detailed ANIME illustration in a rich modern anime style — clean sharp linework, layered cel shading, and dense, highly-detailed backgrounds. FIRST-PERSON POV ('pov'): the camera IS the viewer's own eyes, so we see the world directly in front of YOU, and your OWN hands, arms, legs or feet enter the frame when you act (your hands on the tools, your feet on the path, your view over the table). There is NO separate protagonist standing in the scene, and the protagonist's FACE is NEVER shown — no front-facing face, no mirror, no reflection, no selfie; the viewer is inside the body looking out. An occasional over-the-shoulder / from-behind view of your own back (head seen from behind only) is fine for variety, but NEVER a face. The richly DETAILED background is the true subject and FILLS the whole frame — pack it with specific props, textures, depth and life. Any visible part of your body reads as an ordinary young man's — plain simple clothing, ordinary hands — unless the prompt says otherwise. PALETTE: bright, clean and COLOURFUL across the full range (fresh greens, sky blues, clear reds, natural skin), lit naturally for the time of day — NO yellow/amber/sepia wash or tint over the picture; never grey, muddy or drab. Crisp, detailed and immersive.",
  "stick-fpv":
    "FIRST-PERSON POV ('pov') with a signature TRADEMARK look. CRITICAL — whenever your body enters frame (hands, fingers, wrists and forearms, INCLUDING the sleeve/clothing on them) it is drawn as a BOLD FLAT 2D CARTOON: clean THICK dark outlines and simple flat fill, a deliberate hand-drawn doodle (xkcd / comic style), NEVER realistic skin, NEVER photoreal fabric, NEVER 3D or shaded — the whole visible limb, sleeve and all, is ONE flat cartoon shape with a bold outline, and both hands match each other exactly. This deliberate contrast — a bold flat cartoon body inside a RICHLY DETAILED, believable, real-feeling world — IS the entire style; keep it identical every shot. The FACE is NEVER shown (no front-facing view, mirror, reflection or selfie) — the camera is your own eyes looking out. The WORLD / BACKGROUND is the true subject and FILLS the whole vertical frame: densely detailed, real materials, textures, depth and natural light, packed with the specific props, structures and life the scene describes — ONLY your own body is flat cartoon, everything else is richly rendered. Light it naturally and cleanly for the time of day; avoid a heavy yellow/amber/sepia wash. Crisp, immersive.",
  "stick-fal":
    "RICHLY DETAILED, ILLUSTRATED BACKGROUND of the specific place, objects and structures described — a believable, detailed environment with real depth, materials, textures and natural lighting, densely detailed and full (small props, surroundings, layered foreground/middle/distance), like a beautifully detailed illustrated / animated-film background, NOT a photograph. Keep the SAME illustrated finish and level of detail for EXTERIORS as interiors — outdoor scenes are NEVER pushed to photoreal — since a flat cartoon stick figure is composited on top and must not look pasted onto a photo. Never a flat or bare backdrop. PALETTE: bright, clean and colourful using the FULL range of colour (greens, blues, reds, whites), lit naturally for the time of day — NO yellow/amber/sepia wash or tint over the whole picture (that muddy overlay looks AI-made); never grey, muddy, drab or gloomy, and never uniformly yellow-tinted. Leave a wide, clear, mostly-empty foreground with open ground for the character. NO people, no characters, no figures of any kind — the character is added separately.",
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
