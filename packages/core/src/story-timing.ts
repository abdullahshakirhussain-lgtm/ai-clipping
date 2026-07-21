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
