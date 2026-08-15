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
export const LOST_STYLE_ANCHOR =
  "Soft painterly ANIME illustration in the warm, peaceful style of a beautiful modern anime film (Ghibli-like) — gentle brushwork, soft natural light, cosy and richly detailed. The subject is a PEACEFUL, LIVED-IN, self-sufficient community: people living a calm, content life close to nature, WITHOUT any modern technology — either simple modern off-grid living or an idyllic gentle past. It must feel WARM, ALIVE and inviting — the kind of place that makes you think 'living here would be so peaceful': tidy gardens, tended fields, warm lantern or hearth light, animals, food, neighbours going about their day. People ARE present and content, but shown SMALL, at a distance, or from BEHIND — never a close-up face or portrait. It is NOT ruined, abandoned, overgrown or empty, and there is NO modern technology visible (no cars, phones, screens, power lines, plastic). The scene is richly detailed, full of gentle life and nature, the setting filling the frame. PALETTE: warm and cosy — golden-hour glow, sunset skies, and warm lantern/hearth light are all WELCOME (this is the Ghibli warmth). The thing to avoid is the CHEAP FLAT FILTER, not the warmth: keep the FULL colour range and real light — warm light paired with COOL shadows, and blues/greens still present, so the warmth reads as actual sunlight in the scene, NOT a uniform yellow/sepia tint dropped over the whole image that mutes and muddies everything. Vary the time of day across the series (some golden, some cool bright morning, some blue dusk) so it isn't always orange. Beautiful, tranquil, wholesome and quiet. NO on-screen text, letters, captions, watermarks or logos of any kind.";

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
