/**
 * "Lost Chronicles" — the locked look for the calm anime Veo shorts. A single,
 * fixed aesthetic so every clip in the series reads as one recognizable set:
 * soft painterly anime of a PEACEFUL, LIVED-IN community without modern tech —
 * simple self-sufficient life close to nature (off-grid-modern OR an idyllic
 * gentle past). The feeling is "living here would be so peaceful", NOT empty
 * ruins.
 *
 * The still prompt (from the LLM) describes ONE warm, populated scene; this
 * anchor is appended so the medium, grade and mood are identical every time. No
 * on-screen text — the creator adds music on the platform. People ARE present
 * and content, but shown SMALL / from a distance / from behind — never a
 * close-up face (relatability + Veo's person limits + no per-video face to keep
 * consistent).
 */
// LEAN tail only — a long style essay drowns the scene instructions (people,
// aerial, detail all got ignored). The trigger word + the planner's rich scene do
// the heavy lifting; this just pins medium, light and the no-text rule.
export const LOST_STYLE_ANCHOR =
  "Soft painterly Ghibli-like anime illustration, richly detailed, warm natural light with cool shadows and full clean colour (no flat yellow/sepia wash), cosy, peaceful and lived-in. No on-screen text, letters, captions, watermarks or logos.";

/** Negative prompt for the Veo motion pass (models that accept it — Lite ignores
 *  it, which is fine because the seed still already carries the whole look). */
export const LOST_NEGATIVE =
  "on-screen text, subtitles, captions, watermark, logo, signature, human face, close-up portrait, modern technology, cars, phones, screens, power lines, plastic, ruined, abandoned, derelict, overgrown, empty, harsh photorealism, fast motion, camera shake, jump cut, flicker, distorted anatomy, extra limbs, blurry, low quality";

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
