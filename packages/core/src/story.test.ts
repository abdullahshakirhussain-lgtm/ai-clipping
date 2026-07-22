import {
  alignmentToWords,
  MockImageProvider,
  MockLlmProvider,
  narratorInstruction,
  STORY_NARRATORS,
  STYLE_PRESETS,
  styledImagePrompt,
} from "@clipfactory/ai";
import { buildAss, planCaptionTiming } from "@clipfactory/media";
import { describe, expect, it } from "vitest";
import { planStoryTiming } from "./story-timing.js";

describe("planCaptionTiming", () => {
  it("spreads each beat's words across its duration, contiguous and non-overlapping", () => {
    const segs = planCaptionTiming([
      { text: "one two three four", durationSec: 4 },
      { text: "five six", durationSec: 2 },
    ]);
    expect(segs).toHaveLength(2);
    // Beat 1: 0..4, four words → 1s each.
    expect(segs[0]!.start).toBe(0);
    expect(segs[0]!.end).toBe(4);
    expect(segs[0]!.words).toHaveLength(4);
    expect(segs[0]!.words[0]).toMatchObject({ word: "one", start: 0, end: 1 });
    // Beat 2 starts exactly where beat 1 ended (no gap, no overlap).
    expect(segs[1]!.start).toBe(4);
    expect(segs[1]!.end).toBe(6);
    expect(segs[1]!.words[0]!.start).toBe(4);
    expect(segs[1]!.words.at(-1)!.end).toBeCloseTo(6, 5);
  });

  it("skips empty beats but still advances the clock", () => {
    const segs = planCaptionTiming([
      { text: "", durationSec: 1.5 },
      { text: "hello world", durationSec: 2 },
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.start).toBe(1.5); // second beat pushed past the (silent) first
  });
});

describe("story style presets", () => {
  it("appends a locked style anchor to every beat prompt", () => {
    for (const key of Object.keys(STYLE_PRESETS)) {
      const out = styledImagePrompt("a cat on a wall", key);
      expect(out).toContain("a cat on a wall");
      expect(out).toContain(STYLE_PRESETS[key]!.slice(0, 20));
      expect(out.toLowerCase()).toContain("9:16");
    }
  });

  it("falls back to the default style for an unknown key", () => {
    const out = styledImagePrompt("x", "nope");
    expect(out).toContain(STYLE_PRESETS.doodle!.slice(0, 20));
  });
});

describe("narrator instructions (human read)", () => {
  it("composes persona base + this beat's delivery, varying per beat", () => {
    const a = narratorInstruction("storyteller", "Open slow and curious.");
    const b = narratorInstruction("storyteller", "Shout the reveal.");
    expect(a).toContain(STORY_NARRATORS.storyteller!.slice(0, 20));
    expect(a).toContain("Open slow and curious.");
    expect(a).not.toEqual(b); // per-beat delivery makes each read different
  });
  it("falls back to the default persona and works with no delivery", () => {
    const out = narratorInstruction("nope");
    expect(out).toBe(STORY_NARRATORS.storyteller);
  });
});

describe("buildAss caption position override", () => {
  const seg = [{ start: 0, end: 2, text: "hi there", words: [{ start: 0, end: 1, word: "hi" }, { start: 1, end: 2, word: "there" }] }];
  const alignmentOf = (ass: string) => ass.match(/^Style: Default,[^\n]*/m)![0].split(",")[11];
  it("top/middle/bottom map to distinct ASS alignments", () => {
    expect(alignmentOf(buildAss(seg, 0, 2, "bold-center", 3, "top"))).toBe("8");
    expect(alignmentOf(buildAss(seg, 0, 2, "bold-center", 3, "middle"))).toBe("5");
    expect(alignmentOf(buildAss(seg, 0, 2, "bold-center", 3, "bottom"))).toBe("2");
  });
  it("without a position, keeps the style's own alignment", () => {
    // clean-bottom is alignment 2 by default.
    expect(alignmentOf(buildAss(seg, 0, 2, "clean-bottom", 3))).toBe("2");
  });
});

describe("continuous-narration timing (v3)", () => {
  const beats = [{ text: "one two" }, { text: "three four five six" }]; // 2 + 4 words

  it("proportional: slide durations split by word share of the real duration", () => {
    const { slideDurations, captionSegments } = planStoryTiming(beats, 12);
    // 2/6 and 4/6 of 12s.
    expect(slideDurations[0]).toBeCloseTo(4, 5);
    expect(slideDurations[1]).toBeCloseTo(8, 5);
    expect(captionSegments.length).toBeGreaterThan(0);
  });

  it("exact word timings snap image cuts to word boundaries and sum to total", () => {
    // 6 words at 1s each, total 6s. Beat 1 ends after word 2 (start=2s).
    const words = Array.from({ length: 6 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 1 }));
    const { slideDurations, captionSegments } = planStoryTiming(beats, 6, words);
    expect(slideDurations[0]).toBeCloseTo(2, 5); // words 0-1
    expect(slideDurations[0]! + slideDurations[1]!).toBeCloseTo(6, 5);
    // Captions come straight from the exact words.
    expect(captionSegments[0]!.words).toHaveLength(6);
  });
});

describe("ElevenLabs alignment → words", () => {
  it("folds characters into words by whitespace and drops audio tags", () => {
    // "hi [x] yo" → words "hi","yo"; the [x] tag is excluded.
    const chars = "hi [x] yo".split("");
    const words = alignmentToWords({
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
    });
    expect(words.map((w) => w.word)).toEqual(["hi", "yo"]);
    expect(words[0]!.start).toBeCloseTo(0, 5);
  });
});

describe("mock providers for keyless story runs", () => {
  it("writeStory returns beats with prompts + per-beat delivery", async () => {
    const llm = new MockLlmProvider();
    const story = await llm.writeStory({ topic: "the Eiffel Tower scam", style: "doodle", maxBeats: 16, maxWords: 280 });
    expect(story.beats.length).toBeGreaterThanOrEqual(5);
    expect(story.beats.length).toBeLessThanOrEqual(16);
    for (const b of story.beats) {
      expect(b.text.length).toBeGreaterThan(0);
      expect(b.imagePrompt.length).toBeGreaterThan(0);
      expect(b.delivery && b.delivery.length).toBeGreaterThan(0);
    }
    expect(story.title).toContain("Eiffel Tower");
  });

  it("embeds audio tags only when the provider speaks them", async () => {
    const llm = new MockLlmProvider();
    const tagged = await llm.writeStory({ topic: "x", style: "doodle", maxBeats: 8, maxWords: 280, voiceTags: true });
    const clean = await llm.writeStory({ topic: "x", style: "doodle", maxBeats: 8, maxWords: 280, voiceTags: false });
    expect(tagged.beats.some((b) => /\[[^\]]+\]/.test(b.text))).toBe(true);
    expect(clean.beats.some((b) => /\[[^\]]+\]/.test(b.text))).toBe(false);
  });

  it("suggestStoryTopics returns the requested count", async () => {
    const llm = new MockLlmProvider();
    expect(await llm.suggestStoryTopics({ count: 5 })).toHaveLength(5);
  });

  it("mock image provider returns a valid PNG buffer", async () => {
    const img = new MockImageProvider();
    const { image, ext } = await img.generate({ prompt: "a stick figure" });
    expect(ext).toBe("png");
    // PNG magic number.
    expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
