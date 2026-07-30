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

/**
 * Decide how many STILLS each beat gets so no image sits on screen much longer
 * than `targetSec`.
 *
 * A narrated beat is a whole sentence, which can easily run 6-8 seconds — long
 * enough for a viewer to feel nothing is happening. Rather than force the writer
 * into 8-word fragments (which wrecks the narration), the sentence stays intact
 * and its screen time is divided between several images of the same moment.
 *
 * `maxImages` is a hard cost ceiling; when the ideal split would exceed it, the
 * longest beats keep their extra stills and the shortest give theirs up first,
 * so the budget lands where the dead air actually is. Pure, so it's unit-tested.
 */
export function planImageCadence(
  slideDurations: number[],
  targetSec: number,
  maxImages: number,
): CadenceSlide[] {
  const n = slideDurations.length;
  if (n === 0) return [];
  const target = Math.max(0.5, targetSec);

  // Ideal split per beat, capped at 2 stills. The model can reliably make ONE
  // beat into 2 genuinely-distinct shots; asking for 3-4 is where it starts
  // returning generic or repeated variations (and padding then duplicates them).
  const want = slideDurations.map((d) => Math.max(1, Math.min(2, Math.round(d / target))));

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
