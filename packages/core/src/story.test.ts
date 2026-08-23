import {
  alignmentToWords,
  DEFAULT_STYLE,
  MockImageProvider,
  MockLlmProvider,
  narratorInstruction,
  STORY_NARRATORS,
  STYLE_PRESETS,
  styledImagePrompt,
} from "@clipfactory/ai";
import { buildAss, planCaptionTiming } from "@clipfactory/media";
import { describe, expect, it } from "vitest";
import { planCallCaptions, planStoryTiming } from "./story-timing.js";

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
    expect(out).toContain(STYLE_PRESETS[DEFAULT_STYLE]!.slice(0, 20));
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

  it("INCOMPLETE word timings fall back to proportional (no cadence collapse)", () => {
    // Many-beat story but only a couple of word timings survived (a TTS chunk
    // dropped its alignment). The old word path collapsed all but one beat to
    // ~0.3s and dumped the rest on the last, giving a few 10s+ holds. The guard
    // must instead split time proportionally so cadence stays healthy.
    const many = Array.from({ length: 10 }, () => ({ text: "alpha beta gamma" })); // 30 words
    const partial = [{ word: "alpha", start: 0, end: 1 }, { word: "beta", start: 1, end: 2 }]; // only 2
    const { slideDurations } = planStoryTiming(many, 60, partial);
    // Proportional: every beat equal (~6s each), none clamped to the 0.3s floor.
    expect(Math.min(...slideDurations)).toBeGreaterThan(1);
    expect(slideDurations.every((d) => Math.abs(d - 6) < 0.01)).toBe(true);
  });
});

describe("planCallCaptions (two-speaker call captions)", () => {
  const lines = [
    { speaker: "Dave", text: "hello are you there" }, // 4 words
    { speaker: "Mia", text: "yes stop calling" }, // 3 words
  ];
  const names: [string, string] = ["Dave", "Mia"];

  it("tags each line with its speaker index (0/1), case-insensitively", () => {
    const { captionSegments } = planCallCaptions(lines, names, 7);
    expect(captionSegments.map((s) => s.speaker)).toEqual([0, 1]);
    // An unknown / differently-cased label still maps sensibly.
    const mixed = planCallCaptions([{ speaker: "DAVE", text: "hi" }, { speaker: "someone", text: "no" }], names, 4);
    expect(mixed.captionSegments.map((s) => s.speaker)).toEqual([0, 1]);
  });

  it("without word timings, spreads lines across the duration by word count", () => {
    const { slideDurations, captionSegments } = planCallCaptions(lines, names, 7);
    // 4 and 3 words of 7 total → 4s then 3s.
    expect(slideDurations[0]).toBeCloseTo(4, 5);
    expect(slideDurations[1]).toBeCloseTo(3, 5);
    expect(captionSegments[1]!.start).toBeCloseTo(4, 5);
    // Each line's own words are spread inside its span for caption chunking.
    expect(captionSegments[0]!.words).toHaveLength(4);
  });

  it("with word timings, snaps line spans to the real audio (not just word share)", () => {
    // 7 words at 1s each, total 7s. Line 1 = words 0-3, line 2 = words 4-6.
    const words = Array.from({ length: 7 }, (_, i) => ({ start: i, end: i + 1, word: `w${i}` }));
    const { captionSegments } = planCallCaptions(lines, names, 7, words);
    expect(captionSegments[0]!.start).toBeCloseTo(0, 5);
    expect(captionSegments[0]!.end).toBeCloseTo(4, 5); // ends at word 4's start boundary
    expect(captionSegments[1]!.start).toBeCloseTo(4, 5);
    expect(captionSegments[1]!.end).toBeCloseTo(7, 5);
  });

  it("returns empty for no lines", () => {
    expect(planCallCaptions([], names, 10)).toEqual({ slideDurations: [], captionSegments: [] });
  });
});

describe("buildAss speaker colours (two-voice calls)", () => {
  const segs = [
    { start: 0, end: 2, text: "hello", speaker: 0 },
    { start: 2, end: 4, text: "goodbye", speaker: 1 },
  ];

  it("emits a per-speaker style and colours each line by speaker", () => {
    const ass = buildAss(segs, 0, 4, "clean-bottom", 3, "bottom", { width: 1080, height: 1920 }, ["&H00FFFFFF", "&H0042C5FF"]);
    expect(ass).toMatch(/^Style: Spk0,.*&H00FFFFFF/m);
    expect(ass).toMatch(/^Style: Spk1,.*&H0042C5FF/m);
    // Each dialogue line references its speaker's style.
    expect(ass).toMatch(/^Dialogue:[^\n]*,Spk0,,[^\n]*HELLO/m);
    expect(ass).toMatch(/^Dialogue:[^\n]*,Spk1,,[^\n]*GOODBYE/m);
  });

  it("without speakerColours, every line uses Default (unchanged for other formats)", () => {
    const ass = buildAss(segs, 0, 4, "clean-bottom", 3, "bottom");
    expect(ass).not.toContain("Style: Spk0");
    expect(ass).toMatch(/^Dialogue:[^\n]*,Default,,/m);
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
