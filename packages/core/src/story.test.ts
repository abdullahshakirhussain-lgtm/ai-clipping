import {
  MockImageProvider,
  MockLlmProvider,
  narratorInstruction,
  STORY_NARRATORS,
  STYLE_PRESETS,
  styledImagePrompt,
} from "@clipfactory/ai";
import { buildAss, planCaptionTiming } from "@clipfactory/media";
import { describe, expect, it } from "vitest";

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

describe("mock providers for keyless story runs", () => {
  it("writeStory returns beats with prompts + per-beat delivery", async () => {
    const llm = new MockLlmProvider();
    const story = await llm.writeStory({ topic: "the Eiffel Tower scam", style: "doodle", targetBeats: 8 });
    expect(story.beats).toHaveLength(8);
    for (const b of story.beats) {
      expect(b.text.length).toBeGreaterThan(0);
      expect(b.imagePrompt.length).toBeGreaterThan(0);
      expect(b.delivery && b.delivery.length).toBeGreaterThan(0);
    }
    expect(story.title).toContain("Eiffel Tower");
  });

  it("embeds audio tags only when the provider speaks them", async () => {
    const llm = new MockLlmProvider();
    const tagged = await llm.writeStory({ topic: "x", style: "doodle", targetBeats: 4, voiceTags: true });
    const clean = await llm.writeStory({ topic: "x", style: "doodle", targetBeats: 4, voiceTags: false });
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
