import { promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFrames } from "./ffmpeg.js";

// onnxruntime-node and sharp are loaded LAZILY (dynamic import) so their native
// bindings only initialize when reframing is actually used. If a binary is
// missing/broken in the container, planReframe catches it and falls back to the
// center crop — it never crashes the API at startup.

/**
 * Local subject-aware reframing (v1: smart horizontal reposition).
 *
 * Samples a handful of frames from the clip, runs a tiny on-device face detector
 * (Ultra-Light ~1.2MB ONNX), and returns the dominant face's horizontal center as
 * a normalized 0-1 focus point. renderClip then shifts the 9:16 crop to that point
 * so an off-center speaker stays framed instead of being sliced off.
 *
 * Everything degrades to `null` (→ caller uses the default center crop) on any
 * failure — a missing model, no faces, decode errors, etc. — so it can never
 * break a render. Full motion-tracking (a moving crop) is a v2 on top of this.
 */

const MODEL_PATH = fileURLToPath(new URL("../models/face-detector.onnx", import.meta.url));
const IN_W = 320;
const IN_H = 240;
const SCORE_THRESHOLD = 0.7;
const SAMPLES = 6;

type OrtModule = typeof import("onnxruntime-node");
type Session = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

let sessionPromise: Promise<Session> | null = null;
function getSession(): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-node");
      // logSeverityLevel 4 silences this old model's noisy initializer warnings.
      return ort.InferenceSession.create(MODEL_PATH, { logSeverityLevel: 4 });
    })();
  }
  return sessionPromise;
}

/** Detect the dominant (largest, most-confident) face's normalized center x, or null. */
async function detectDominantFaceX(jpegPath: string): Promise<number | null> {
  const [{ default: sharp }, ort] = await Promise.all([
    import("sharp"),
    import("onnxruntime-node"),
  ]);
  const { data } = await sharp(jpegPath)
    .resize(IN_W, IN_H, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // HWC uint8 RGB → NCHW float32, normalized (x - 127) / 128 (Ultra-Light spec).
  const plane = IN_H * IN_W;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    chw[i] = (data[i * 3]! - 127) / 128;
    chw[plane + i] = (data[i * 3 + 1]! - 127) / 128;
    chw[2 * plane + i] = (data[i * 3 + 2]! - 127) / 128;
  }

  const session = await getSession();
  const out = await session.run({ input: new ort.Tensor("float32", chw, [1, 3, IN_H, IN_W]) });
  const scores = out.scores!.data as Float32Array; // [1, N, 2] → [bg, face] per anchor
  const boxes = out.boxes!.data as Float32Array; // [1, N, 4] → normalized [x1,y1,x2,y2]
  const n = scores.length / 2;

  let bestScore = 0;
  let bestX: number | null = null;
  for (let i = 0; i < n; i++) {
    const faceProb = scores[i * 2 + 1]!;
    if (faceProb < SCORE_THRESHOLD) continue;
    const x1 = boxes[i * 4]!;
    const x2 = boxes[i * 4 + 2]!;
    const y1 = boxes[i * 4 + 1]!;
    const y2 = boxes[i * 4 + 3]!;
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const rank = area * faceProb; // prefer the big, confident face = the speaker
    if (rank > bestScore) {
      bestScore = rank;
      bestX = (x1 + x2) / 2;
    }
  }
  return bestX !== null && bestX >= 0 && bestX <= 1 ? bestX : null;
}

export interface ReframePlan {
  /** Normalized 0-1 horizontal focus (dominant face center) to crop around. */
  focusX: number;
  /** How many sampled frames a face was found in. */
  samples: number;
}

/** Plan a smart crop focus for a clip window, or null to fall back to center crop. */
export async function planReframe(input: {
  inputPath: string;
  startSec: number;
  endSec: number;
  workDir: string;
}): Promise<ReframePlan | null> {
  const dir = join(input.workDir, `reframe-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const frames = await extractFrames(input.inputPath, input.startSec, input.endSec, SAMPLES, dir);
    const xs: number[] = [];
    for (const f of frames) {
      const x = await detectDominantFaceX(f).catch(() => null);
      if (x !== null) xs.push(x);
    }
    if (xs.length === 0) return null;
    xs.sort((a, b) => a - b);
    return { focusX: xs[Math.floor(xs.length / 2)]!, samples: xs.length };
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
