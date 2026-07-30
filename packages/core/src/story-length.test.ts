import { buildAss } from "@clipfactory/media";
import { styledImagePrompt } from "@clipfactory/ai";
import { describe, expect, it, vi } from "vitest";
import { lengthPreset, StoryService } from "./services/story-service.js";
import { looksLikeColdOpen } from "./pipeline/stages.js";

describe("lengthPreset — one knob drives the whole shape", () => {
  it("long-form is 16:9, landscape image size, long word band", () => {
    const p = lengthPreset("long", 50);
    expect(p.aspect).toBe("16:9");
    expect(p.imageSize).toBe("1536x1024");
    expect(p.maxBeats).toBe(50); // filled from the env cap
    expect(p.minWords).toBe(1050);
    expect(p.maxWords).toBe(1300);
  });

  it("short is 9:16, portrait image size, short word band over the 60s line", () => {
    const p = lengthPreset("short", 50);
    expect(p.aspect).toBe("9:16");
    expect(p.imageSize).toBe("1024x1536");
    expect(p.maxBeats).toBe(14);
    // ~150-220 words at 150wpm ≈ 60-88s — comfortably past the 60s monetization line.
    expect(p.minWords).toBeGreaterThanOrEqual(150);
    expect(p.maxWords).toBeLessThanOrEqual(220);
  });
});

describe("styledImagePrompt — orientation follows the aspect", () => {
  it("landscape asks for 16:9 and never 9:16", () => {
    const out = styledImagePrompt("a dig site", "stick-scene", "a desert", "landscape");
    expect(out).toContain("16:9");
    expect(out).not.toContain("9:16");
  });

  it("portrait (the default) asks for 9:16", () => {
    expect(styledImagePrompt("a dig site", "stick-scene", "a desert", "portrait")).toContain("9:16");
    expect(styledImagePrompt("a dig site", "stick-scene")).toContain("9:16");
  });
});

describe("buildAss — caption canvas matches the aspect", () => {
  const seg = [{ start: 0, end: 2, text: "hi", words: [{ start: 0, end: 2, word: "hi" }] }];
  const playRes = (ass: string) => ({
    x: Number(ass.match(/PlayResX:\s*(\d+)/)![1]),
    y: Number(ass.match(/PlayResY:\s*(\d+)/)![1]),
  });
  const fontSize = (ass: string) => Number(ass.match(/^Style: Default,[^,]*,(\d+)/m)![1]);

  it("defaults to a 1080x1920 portrait canvas", () => {
    expect(playRes(buildAss(seg, 0, 2))).toEqual({ x: 1080, y: 1920 });
  });

  it("uses a 1920x1080 canvas for long-form and scales the font down to match", () => {
    const portrait = buildAss(seg, 0, 2);
    const landscape = buildAss(seg, 0, 2, "bold-center", 3, undefined, { width: 1920, height: 1080 });
    expect(playRes(landscape)).toEqual({ x: 1920, y: 1080 });
    // Font is authored for a 1920-tall canvas; on a 1080-tall one it must shrink,
    // or captions would render oversized.
    expect(fontSize(landscape)).toBeLessThan(fontSize(portrait));
  });
});

describe("looksLikeColdOpen — reject the preamble intro", () => {
  it("accepts the mandated cold-open stems", () => {
    expect(looksLikeColdOpen("It's August 1998. A night guard starts his round.")).toBe(true);
    expect(looksLikeColdOpen("In a small town in Wales, a homeless man dies.")).toBe(true);
    expect(looksLikeColdOpen("Imagine standing on a frozen river at midnight.")).toBe(true);
    expect(looksLikeColdOpen("1943. A body washes ashore in Spain.")).toBe(true);
  });

  it("rejects topic-announcing preambles (the '50-second intro')", () => {
    expect(looksLikeColdOpen("This is the story of the Antikythera mechanism.")).toBe(false);
    expect(looksLikeColdOpen("Did you know that ancient humans met other species?")).toBe(false);
    expect(looksLikeColdOpen("In this video, we'll explore a wild discovery.")).toBe(false);
    expect(looksLikeColdOpen("Today we're talking about a famous heist.")).toBe(false);
    expect(looksLikeColdOpen("")).toBe(false);
  });
});

describe("suggestTopics — steers away from what's already been made", () => {
  it("passes recent STORY titles as the avoid list, ignoring other kinds", async () => {
    const suggestStoryTopics = vi.fn().mockResolvedValue(["a fresh one"]);
    const list = vi.fn().mockResolvedValue([
      { kind: "story", title: "The Eiffel Tower scam" },
      { kind: "cook", title: "Campfire ribeye" }, // not a story → excluded
      { kind: "story", title: "The Antikythera mechanism" },
      { kind: "story", title: null }, // no title → excluded
    ]);
    const repos = { sourceVideos: { list } } as never;
    const svc = new StoryService(repos, { suggestStoryTopics } as never, {} as never, 50);

    await svc.suggestTopics("history");

    expect(suggestStoryTopics).toHaveBeenCalledTimes(1);
    const arg = suggestStoryTopics.mock.calls[0]![0] as { category?: string; avoid?: string[] };
    expect(arg.category).toBe("history");
    expect(arg.avoid).toEqual(["The Eiffel Tower scam", "The Antikythera mechanism"]);
  });
});
