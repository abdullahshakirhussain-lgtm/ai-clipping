import { describe, it, expect } from "vitest";
import { lostStillPrompt, lostGptPrompt, LOST_STYLE_ANCHOR, LOST_NEGATIVE, MockLlmProvider } from "@clipfactory/ai";

describe("Lost Chronicles", () => {
  it("still prompt embeds the scene, the anime anchor, and forbids on-screen text", () => {
    const p = lostStillPrompt("a Tuscan hillside village");
    expect(p).toContain("a Tuscan hillside village");
    expect(p).toMatch(/anime/i);
    expect(p.toLowerCase()).toContain("no text");
  });

  it("style anchor is a lean Ghibli tail (no flat-yellow wash, no on-screen text)", () => {
    expect(LOST_STYLE_ANCHOR).toMatch(/ghibli/i);
    expect(LOST_STYLE_ANCHOR).toMatch(/no flat yellow|yellow\/sepia wash/i);
    expect(LOST_STYLE_ANCHOR).toMatch(/no on-screen text/i);
  });

  it("gpt-stage prompt fixes the yellow + crowd (cool light, NOT sepia, modest people)", () => {
    const p = lostGptPrompt("a Tuscan hillside village");
    expect(p).toContain("a Tuscan hillside village");
    expect(p).toMatch(/NOT sepia|yellow-tinted/i);
    expect(p).toMatch(/modest/i);
  });

  it("negative prompt blocks on-screen text, faces, modern tech and ruins", () => {
    expect(LOST_NEGATIVE).toMatch(/text/i);
    expect(LOST_NEGATIVE).toMatch(/face/i);
    expect(LOST_NEGATIVE).toMatch(/modern technology|cars/i);
    expect(LOST_NEGATIVE).toMatch(/ruined|abandoned/i);
  });

  it("planner returns an AERIAL village still + gentle motion + '#' hashtags", async () => {
    const plan = await new MockLlmProvider().planLostScene({ scene: "a Swiss alpine hamlet" });
    expect(plan.stillPrompt).toMatch(/aerial|bird's-eye/i);
    expect(plan.motionPrompt.length).toBeGreaterThan(0);
    expect(plan.hashtags.every((h) => h.startsWith("#"))).toBe(true);
  });

  it("scene suggester returns REAL, recognisable places", async () => {
    const scenes = await new MockLlmProvider().suggestLostScenes({ count: 8 });
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.join(" ")).toMatch(/Tuscan|Swiss|Japanese|Greek|village|hamlet/i);
  });
});
