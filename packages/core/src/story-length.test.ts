import { buildAss } from "@clipfactory/media";
import { asArray, strList, styledImagePrompt } from "@clipfactory/ai";
import { describe, expect, it, vi } from "vitest";
import { CreateStoryInputSchema } from "./contracts/story.js";
import { lengthPreset, StoryService } from "./services/story-service.js";
import { looksLikeColdOpen, stripAiTells, stripCringeEnding } from "./pipeline/stages.js";

describe("CreateStoryInput defaults", () => {
  it("defaults to scenario mode, SHORT form, stick-openai, clean bottom captions", () => {
    const parsed = CreateStoryInputSchema.parse({ topic: "ancient Roman hygiene" });
    expect(parsed.mode).toBe("scenario");
    expect(parsed.length).toBe("short");
    expect(parsed.style).toBe("stick-openai");
    expect(parsed.captionStyle).toBe("clean-bottom");
    expect(parsed.captionPosition).toBe("bottom");
  });

  it("accepts an explicit story mode + short form", () => {
    const parsed = CreateStoryInputSchema.parse({ topic: "the Antwerp diamond heist", mode: "story", length: "short" });
    expect(parsed.mode).toBe("story");
    expect(parsed.length).toBe("short");
  });
});

describe("lengthPreset — one knob drives the whole shape", () => {
  it("long-form is 16:9, landscape image size, long word band", () => {
    const p = lengthPreset("long", 50);
    expect(p.aspect).toBe("16:9");
    expect(p.imageSize).toBe("1536x1024");
    expect(p.maxBeats).toBe(50); // filled from the env cap
    // Beat FLOOR near the cap — this is what drives ~150 images (≤3 stills/beat),
    // and its absence was why long form kept landing at ~36.
    expect(p.minBeats).toBe(44);
    expect(p.minBeats).toBeLessThan(p.maxBeats);
    expect(p.minWords).toBe(1050);
    expect(p.maxWords).toBe(1300);
  });

  it("short is 9:16, portrait image size, relaxed band so the story can finish", () => {
    const p = lengthPreset("short", 50);
    expect(p.aspect).toBe("9:16");
    expect(p.imageSize).toBe("1024x1536");
    // maxBeats caps the runtime structurally (one narration chunk per beat), so a
    // short stays under YouTube's 3-min Shorts cap even if the writer runs the word
    // band full: ~18 short sentences ≈ 2-2.5 min.
    expect(p.maxBeats).toBe(18);
    expect(p.minBeats).toBe(10);
    expect(p.minWords).toBeGreaterThanOrEqual(220);
    expect(p.maxWords).toBeLessThanOrEqual(360);
  });
});

describe("styledImagePrompt — orientation follows the aspect", () => {
  it("landscape asks for 16:9 and never 9:16", () => {
    const out = styledImagePrompt("a dig site", "stick-openai", "a desert", "landscape");
    expect(out).toContain("16:9");
    expect(out).not.toContain("9:16");
  });

  it("portrait (the default) asks for 9:16", () => {
    expect(styledImagePrompt("a dig site", "stick-openai", "a desert", "portrait")).toContain("9:16");
    expect(styledImagePrompt("a dig site", "stick-openai")).toContain("9:16");
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

describe("model-output array coercion (tool schemas are hints, not guarantees)", () => {
  it("asArray keeps arrays, drops non-arrays to []", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray("nope")).toEqual([]); // a stray string is NOT split into chars
    expect(asArray(undefined)).toEqual([]);
    expect(asArray({ 0: "x" })).toEqual([]);
  });

  it("strList splits a delimited string so 'hashtags as a string' doesn't crash", () => {
    // The exact failure: the model returned hashtags as "#history #victorian".
    expect(strList("#history #victorian, #mining")).toEqual(["#history", "#victorian", "#mining"]);
    expect(strList(["#a", "#b"])).toEqual(["#a", "#b"]);
    expect(strList(undefined)).toEqual([]);
    expect(() => strList("x").map((s) => s.trim())).not.toThrow();
  });
});

describe("stripCringeEnding — kill the tacked-on closer the blocklist misses", () => {
  const beat = (text: string) => ({ text });

  it("strips a trailing rhetorical question but keeps the real final fact", () => {
    const out = stripCringeEnding([beat("The camp fell silent."), beat("The fire burned out by dawn. But what were they really afraid of?")]);
    expect(out.at(-1)!.text).toBe("The fire burned out by dawn.");
  });

  it("strips a reflective/summary opener", () => {
    const out = stripCringeEnding([beat("They sealed the tomb and left."), beat("And so a whole civilization slipped out of memory.")]);
    // The whole last beat was the closer → it's dropped, prior beat ends.
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("They sealed the tomb and left.");
  });

  it("strips a cringe-phrase sentence tacked onto the last beat", () => {
    const out = stripCringeEnding([beat("The last scribe died alone. It's a reminder that empires are fragile.")]);
    expect(out[0]!.text).toContain("The last scribe died");
    expect(out[0]!.text).not.toMatch(/reminder/i);
  });

  it("leaves a clean factual ending untouched", () => {
    const beats = [beat("Rome burned for six days."), beat("Nero rebuilt the district as his own palace grounds.")];
    expect(stripCringeEnding(beats).at(-1)!.text).toBe("Nero rebuilt the district as his own palace grounds.");
  });

  it("never strips the narration down to nothing", () => {
    const beats = [beat("And that just goes to show how strange it all was.")];
    expect(stripCringeEnding(beats)).toEqual(beats); // one cringe-only beat → keep it rather than ship an empty video
  });

  it("does not mutate the input array", () => {
    const beats = [beat("A fact."), beat("It makes you wonder, doesn't it?")];
    const before = beats[1]!.text;
    stripCringeEnding(beats);
    expect(beats[1]!.text).toBe(before);
  });
});

describe("stripAiTells — scrub the machine-written giveaways", () => {
  const beat = (text: string) => ({ text });

  it("drops a 'here's the strange part:' lead-in, keeping the real statement", () => {
    const out = stripAiTells([beat("You lined up at dawn. And here's the strange part: your meat was measured in money, not weight.")]);
    expect(out[0]!.text).toContain("Your meat was measured in money, not weight.");
    expect(out[0]!.text.toLowerCase()).not.toContain("strange part");
  });

  it("removes a standalone hype sentence with no real payload", () => {
    const out = stripAiTells([beat("The bench was smashed in the square. But that's not the worst part. Guild officers seized the ledgers.")]);
    expect(out[0]!.text).not.toMatch(/worst part/i);
    expect(out[0]!.text).toContain("Guild officers seized the ledgers.");
  });

  it("keeps an ordinary sentence that merely uses a colon", () => {
    const out = stripAiTells([beat("The grocer weighed it out: bacon, sugar, tea and butter.")]);
    expect(out[0]!.text).toBe("The grocer weighed it out: bacon, sugar, tea and butter.");
  });

  it("never empties a beat", () => {
    const out = stripAiTells([beat("Plot twist.")]);
    expect(out[0]!.text.length).toBeGreaterThan(0);
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
