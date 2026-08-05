import { planCaptionTiming } from "@clipfactory/media";
import type { TtsWord } from "@clipfactory/ai";

export interface StoryCaptionSegment {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; word: string }>;
}

export interface StoryTiming {
  /** On-screen seconds for each slide/image, summing to ~totalSec. */
  slideDurations: number[];
  /** Caption segments ready for buildAss. */
  captionSegments: StoryCaptionSegment[];
}

const wordCount = (text: string) => Math.max(1, text.split(/\s+/).filter(Boolean).length);

/**
 * Given the beats (their spoken text) and the ONE continuous narration's total
 * duration, decide when each image changes and how captions are timed.
 *
 * With exact TTS word timings (ElevenLabs) we snap image cuts to real word
 * boundaries and caption to the actual words — perfect sync. Without them
 * (OpenAI/mock) we fall back to spreading words proportionally across the true
 * measured duration, which is far better than the old per-beat drift. Pure, so
 * it's unit-tested.
 */
export function planStoryTiming(
  beats: Array<{ text: string }>,
  totalSec: number,
  words?: TtsWord[],
): StoryTiming {
  const counts = beats.map((b) => wordCount(b.text));

  if (words && words.length > 0) {
    // Image cuts at the narration word that ends each beat.
    const times: number[] = [0];
    let cum = 0;
    for (let i = 0; i < beats.length - 1; i++) {
      cum += counts[i]!;
      const idx = Math.min(cum, words.length - 1);
      times.push(Math.min(words[idx]!.start, totalSec));
    }
    times.push(totalSec);
    const slideDurations = beats.map((_, i) => Math.max(0.3, times[i + 1]! - times[i]!));
    const captionSegments: StoryCaptionSegment[] = [
      {
        start: words[0]!.start,
        end: words[words.length - 1]!.end,
        text: words.map((w) => w.word).join(" "),
        words: words.map((w) => ({ start: w.start, end: w.end, word: w.word })),
      },
    ];
    return { slideDurations, captionSegments };
  }

  // Proportional: each beat gets a share of the real duration by word count.
  const totalWords = counts.reduce((a, c) => a + c, 0);
  const slideDurations = counts.map((c) => Math.max(0.3, (c / totalWords) * totalSec));
  const captionSegments = planCaptionTiming(
    beats.map((b, i) => ({ text: b.text, durationSec: slideDurations[i]! })),
  );
  return { slideDurations, captionSegments };
}

/** One still on screen: which beat it belongs to, and for how long. */
export interface CadenceSlide {
  beatIndex: number;
  /** 0-based position among the stills carved out of that beat. */
  subIndex: number;
  /** How many stills that beat was split into. */
  subCount: number;
  durationSec: number;
}

/** Hard ceiling on stills carved from ONE beat. The splitter (expandImagePrompts)
 *  reliably yields three genuinely-distinct framings — WIDE → CLOSER → DETAIL — of
 *  the same moment; past three it starts returning generic or repeated variations
 *  (which the merge step then collapses anyway), so three is the useful maximum. */
const MAX_STILLS_PER_BEAT = 3;

/** Fast-open tuning: beats that BEGIN inside the opening window are cut against a
 *  tighter target so the hook never holds a static frame — you keep or lose the
 *  viewer here. Still bounded by {@link MAX_STILLS_PER_BEAT}. */
export interface CadenceOpts {
  /** Length of the fast-open window from t=0, in seconds (0 disables it). */
  openSeconds?: number;
  /** Per-still target inside the open window; defaults below the normal target. */
  openTargetSec?: number;
}

/**
 * Decide how many STILLS each beat gets so no image sits on screen much longer
 * than `targetSec` (roughly one change every ~3s), with an even denser OPEN.
 *
 * A narrated beat is a whole sentence, which can easily run 6-8 seconds — long
 * enough for a viewer to feel nothing is happening. Rather than force the writer
 * into 8-word fragments (which wrecks the narration), the sentence stays intact
 * and its screen time is divided between several distinct images of the same
 * moment (up to {@link MAX_STILLS_PER_BEAT}).
 *
 * `maxImages` is a hard cost ceiling; when the ideal split would exceed it, the
 * longest beats keep their extra stills and the shortest give theirs up first,
 * so the budget lands where the dead air actually is. Pure, so it's unit-tested.
 *
 * The same function serves shorts and long form — only the beat count and total
 * duration differ; long form leans on the per-beat split to reach ~3s cadence
 * because it can't have hundreds of beats.
 */
export function planImageCadence(
  slideDurations: number[],
  targetSec: number,
  maxImages: number,
  opts: CadenceOpts = {},
): CadenceSlide[] {
  const n = slideDurations.length;
  if (n === 0) return [];
  const target = Math.max(0.5, targetSec);
  const openSeconds = Math.max(0, opts.openSeconds ?? 0);
  // A beat spanning the open window still can't exceed the cap, so keep this
  // clearly below `target` (not below the 0.5 floor) to actually bite.
  const openTarget = Math.max(0.5, opts.openTargetSec ?? Math.min(target, 1.6));

  // Ideal split per beat. Beats that START within the opening window are cut
  // against the tighter `openTarget`; the rest against `target`. Both capped.
  let cursor = 0;
  const want = slideDurations.map((d) => {
    const beatStart = cursor;
    cursor += d;
    const t = beatStart < openSeconds ? openTarget : target;
    return Math.max(1, Math.min(MAX_STILLS_PER_BEAT, Math.round(d / t)));
  });

  // Trim to budget: repeatedly take a still back from whichever beat currently
  // has the SHORTEST time-per-still, i.e. the one that needs it least.
  let total = want.reduce((a, c) => a + c, 0);
  const budget = Math.max(n, maxImages); // never drop below one still per beat
  while (total > budget) {
    let victim = -1;
    let bestPerStill = Infinity;
    for (let i = 0; i < n; i++) {
      if (want[i]! <= 1) continue;
      const perStill = slideDurations[i]! / (want[i]! - 1);
      if (perStill < bestPerStill) {
        bestPerStill = perStill;
        victim = i;
      }
    }
    if (victim < 0) break; // everything is already at 1
    want[victim]!--;
    total--;
  }

  const slides: CadenceSlide[] = [];
  for (let i = 0; i < n; i++) {
    const k = want[i]!;
    const each = slideDurations[i]! / k;
    for (let s = 0; s < k; s++) {
      slides.push({ beatIndex: i, subIndex: s, subCount: k, durationSec: each });
    }
  }
  return slides;
}
