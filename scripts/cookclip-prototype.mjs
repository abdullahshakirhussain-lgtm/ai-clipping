// ─────────────────────────────────────────────────────────────────────────────
// Cook-in-the-wild ASMR PROTOTYPE (not wired into the app).
//
// Generates ONE vertical (9:16) cooking video with NATIVE audio using
// fal-ai/veo3.1 — one ~8s shot per cooking step, hard-cut together into
// cookclip-prototype.mp4. This exists to answer three questions before we build
// a real pipeline: does it look real, does the native audio land, what's the
// true cost per video.
//
// Run:   FAL_KEY=xxxxx node scripts/cookclip-prototype.mjs
// Tune:  NUM_SHOTS=5   VEO_RES=1080p   (env overrides; defaults below)
//
// ⚠️ Spends real money: veo3.1 is ~$0.40/sec with audio at 720p/1080p, so an 8s
//    clip ≈ $3.20. 5 shots ≈ $16, 8 shots ≈ $26. Start small (NUM_SHOTS=5).
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Resolve the ffmpeg-static binary from the media package (portable — no
// absolute paths). Fails loudly here if the monorepo isn't installed.
const req = createRequire(new URL("../packages/media/package.json", import.meta.url));
const ffmpeg = req("ffmpeg-static");

const FAL_KEY = process.env.FAL_KEY;
const MODEL = process.env.FAL_VIDEO_MODEL || "fal-ai/veo3.1";
const RESOLUTION = process.env.VEO_RES || "1080p"; // 720p (cheaper) | 1080p | 4k
const DURATION = "8s"; // veo3.1 accepts 4s | 6s | 8s
const NUM_SHOTS = Math.max(1, Math.min(8, Number(process.env.NUM_SHOTS) || 5));
const OUT = join(process.cwd(), "cookclip-prototype.mp4");
const WORK = join(process.cwd(), ".cookclip-work");

// The LOCKED BIBLE — repeated verbatim on every shot so nothing drifts between
// cuts. Every aspect the prompt doesn't pin, Veo invents (and invents
// inconsistently: rock off the fire, oil appearing mid-shot). So we pin them
// all: fixed setting, HEAT SETUP (stone directly on the fire), props, hands,
// exposure, and hard "no mid-shot invention" rules. Tighter prompt > retrying.
const STYLE =
  "Photorealistic cinematic close-up, vertical 9:16, calm ASMR mood. " +
  "FIXED SETTING (identical in every shot): a riverside beside a clear, fast-rushing mountain stream. A large flat grey cooking stone rests DIRECTLY ON a low campfire — orange flames and glowing embers clearly visible underneath the stone, heating it from below. Rustic clay bowls, a wooden board and plain wooden utensils sit on the mossy rock beside it. " +
  "FIXED HANDS: only a pair of weathered, sun-tanned bare hands — no rings, no jewellery, no sleeves past the wrist. NEVER a face, never a body, never a second person. " +
  "FIXED LIGHT: soft overcast daylight in open shade — gently diffused, balanced natural exposure, muted earthy greens and greys. NO blown-out highlights, NO harsh glare, NO golden glow. " +
  "CAMERA: shallow depth of field, subtle handheld micro-movement. " +
  "HARD RULES: everything visible is present from the very first frame — nothing appears, changes, or disappears mid-shot unless the on-screen action itself causes it. No on-screen text, no subtitles, no watermark, no logo, no music, no voices, no cartoon or CGI look.";

// Recipe as a shot list. Each shot pins EVERY per-shot aspect: STATE (the food's
// exact condition, carried from the previous shot for continuity), ACTION (one
// clear continuous beat), CAMERA, and an explicit AUDIO cue for veo3.1's native
// sound. (In the app this list comes from an LLM shot-planner; hardcoded here to
// isolate the video model. The planner MUST emit this same fully-specified shape.)
const SHOTS = [
  "STATE: a whole raw silver fish, freshly caught and still wet. ACTION: the hands dip the whole fish into the cold running stream and rinse it, water sheeting off the scales. CAMERA: static close-up, low over the water. AUDIO: rushing river water, faint birdsong, the fire crackling nearby.",
  "STATE: the same rinsed fish, now resting on the wooden board beside the fire. ACTION: the hands press coarse salt and torn green herbs firmly onto both sides of the fish. CAMERA: slightly high, close on the board. AUDIO: the soft grind of salt, fire crackling, the stream behind.",
  "STATE: a small clay bowl holding garlic cloves, red chili and a pour of oil. ACTION: the hands crush and stir it into a glistening red paste with a wooden pestle. CAMERA: top-down on the bowl. AUDIO: wet grinding and stirring, gentle fire crackle, stream ambience.",
  "STATE: the seasoned fish; the flat stone sits on the fire, already glistening with a thin film of hot oil, flames and embers visible beneath it. ACTION: the hands lay the seasoned fish onto the hot oiled stone; it sizzles hard the instant it lands, oil spitting, thin white steam and light smoke rising. CAMERA: close-up, slow push-in. AUDIO: a loud satisfying sizzle, fire crackling directly beneath the stone, a faint steam hiss.",
  "STATE: the fish now cooking and browning on the hot stone over the flames. ACTION: the hands pour a ladle of stream water onto the hot stone beside the fish; a sudden burst of white steam billows up. CAMERA: close-up at stone level. AUDIO: a sharp steam hiss, pouring water, the fire crackling below.",
  "STATE: the fully cooked, golden-browned fish lifted off the stone. ACTION: the hands lay it on a bed of broad green leaves on the wooden board and scatter fresh herbs and a squeeze of lime over it. CAMERA: slightly high, then a slow push-in on the steaming fish. AUDIO: a soft rustle of leaves, a citrus squeeze, gentle steam, running water and birdsong.",
].slice(0, NUM_SHOTS);

const rate = RESOLUTION === "4k" ? 0.6 : 0.4; // per second, audio on
const secs = Number(DURATION.replace("s", ""));
const estimate = (NUM_SHOTS * secs * rate).toFixed(2);

if (!FAL_KEY) {
  console.error("Set FAL_KEY (needs fal-ai/veo3.1 access + billing).");
  console.error(`This run would generate ${NUM_SHOTS} × ${DURATION} @ ${RESOLUTION}+audio ≈ $${estimate}.`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { Authorization: `Key ${FAL_KEY}` };

async function generateShot(i, action) {
  const submit = await fetch(`https://queue.fal.run/${MODEL}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: `${STYLE}\n\n${action}`,
      aspect_ratio: "9:16",
      resolution: RESOLUTION,
      duration: DURATION,
      generate_audio: true,
      negative_prompt: "human faces, on-screen text, subtitles, watermark, logo, blurry, low quality",
    }),
  });
  if (!submit.ok) throw new Error(`shot ${i + 1} submit ${submit.status}: ${(await submit.text()).slice(0, 200)}`);
  const { status_url, response_url, request_id } = await submit.json();
  process.stdout.write(`shot ${i + 1}/${NUM_SHOTS} queued (${request_id}) `);

  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`shot ${i + 1} timed out`);
    await sleep(6000);
    const sj = await (await fetch(status_url, { headers: auth })).json();
    if (sj.status === "COMPLETED") break;
    if (sj.status === "FAILED" || sj.error) throw new Error(`shot ${i + 1} failed: ${JSON.stringify(sj).slice(0, 200)}`);
    process.stdout.write(".");
  }
  const rj = await (await fetch(response_url, { headers: auth })).json();
  const url = rj?.video?.url;
  if (!url) throw new Error(`shot ${i + 1} returned no video url: ${JSON.stringify(rj).slice(0, 200)}`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  const file = join(WORK, `shot-${i}.mp4`);
  writeFileSync(file, bytes);
  console.log(` done (${(bytes.length / 1e6).toFixed(1)}MB)`);
  return file;
}

async function main() {
  console.log(`Model ${MODEL} | ${NUM_SHOTS} shots × ${DURATION} @ ${RESOLUTION} + audio`);
  console.log(`Estimated spend: ${NUM_SHOTS} × ${secs}s × $${rate}/s = $${estimate}\n`);

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const raw = [];
  for (let i = 0; i < SHOTS.length; i++) raw.push(await generateShot(i, SHOTS[i]));

  // Normalize every clip to identical 1080x1920 / 24fps / aac so the concat is a
  // clean stream-copy and shot-to-shot loudness is even (loudnorm).
  console.log("\nNormalizing + assembling…");
  const normed = [];
  for (let i = 0; i < raw.length; i++) {
    const out = join(WORK, `n-${i}.mp4`);
    execFileSync(
      ffmpeg,
      [
        "-y", "-i", raw[i],
        "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=24",
        "-af", "loudnorm",
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        out,
      ],
      { stdio: "ignore" },
    );
    normed.push(out);
  }

  const list = join(WORK, "list.txt");
  writeFileSync(list, normed.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  execFileSync(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", OUT], { stdio: "ignore" });

  console.log(`\n✅ ${OUT}`);
  console.log(`   ${NUM_SHOTS} shots, ${NUM_SHOTS * secs}s total. Actual spend ≈ $${estimate}.`);
}

main().catch((e) => {
  console.error("\n❌", e.message);
  process.exit(1);
});
