/**
 * "Lost Chronicles" — the locked look for the calm anime Veo shorts. A single,
 * fixed aesthetic so every clip in the series reads as one recognizable set:
 * soft painterly anime, wistful and peaceful, a fragment of a forgotten world.
 *
 * The still prompt (from the LLM) describes ONE serene scene; this anchor is
 * appended so the medium, grade and mood are identical every time. No on-screen
 * text — the creator adds music/text on the platform. The protagonist, when
 * present, is a FACELESS lone figure (seen from behind / small in the frame):
 * it avoids the recurring-face consistency problem AND Veo's person limits, and
 * a consistent silhouette becomes the channel's motif.
 */
export const LOST_STYLE_ANCHOR =
  "Soft painterly ANIME illustration in the wistful, peaceful style of a beautiful modern anime film — gentle brushwork, soft volumetric light, rich but calm detail, a quiet 'lo-fi' stillness. The mood is serene, nostalgic and slightly melancholic: a fragment of a forgotten, ancient world at peace. The scene is richly detailed and immersive, the background filling the frame. If a person appears, it is a LONE FACELESS figure — seen from BEHIND or small in the distance, often a hooded/cloaked wanderer — never a visible face, never a close-up portrait. PALETTE: a soft, cohesive grade — warm golden-hour or cool blue-hour light, gentle and filmic, clean and colourful but calm; never harsh, never photorealistic, never a flat yellow/sepia wash. Beautiful, tranquil, and completely quiet. NO on-screen text, letters, captions, watermarks or logos of any kind.";

/** Negative prompt for the Veo motion pass (models that accept it — Lite ignores
 *  it, which is fine because the seed still already carries the whole look). */
export const LOST_NEGATIVE =
  "on-screen text, subtitles, captions, watermark, logo, signature, human face, close-up portrait, harsh photorealism, fast motion, camera shake, jump cut, flicker, distorted anatomy, extra limbs, blurry, low quality";

export type LostOrientation = "portrait" | "landscape";

/**
 * Compose the final STILL prompt: the scene, then the locked anchor and framing.
 * Positive phrasing throughout (the image model has no negative prompt), so the
 * "no text / faceless / calm grade" rules are stated as what IS there.
 */
export function lostStillPrompt(scenePrompt: string, orientation: LostOrientation = "portrait"): string {
  const frame = orientation === "landscape" ? "Horizontal 16:9 widescreen" : "Vertical 9:16 portrait";
  return `${scenePrompt.trim()}. Style: ${LOST_STYLE_ANCHOR} ${frame}, a single calm composition, no text anywhere.`;
}
