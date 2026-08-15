import { describe, it, expect } from "vitest";
import { lostStillPrompt, LOST_STYLE_ANCHOR, LOST_NEGATIVE, MockLlmProvider } from "@clipfactory/ai";

describe("Lost Chronicles", () => {
  it("still prompt embeds the scene, the locked anime anchor, and forbids on-screen text", () => {
    const p = lostStillPrompt("an ancient library swallowed by a forest");
    expect(p).toContain("an ancient library swallowed by a forest");
    expect(p).toContain("ANIME");
    expect(p.toLowerCase()).toContain("no text");
  });

  it("style anchor is a PEACEFUL LIVED-IN community (not ruins), people shown small/from behind", () => {
    expect(LOST_STYLE_ANCHOR).toMatch(/lived-in|self-sufficient|community/i);
    expect(LOST_STYLE_ANCHOR).toMatch(/from BEHIND|small|distance/i);
    expect(LOST_STYLE_ANCHOR).toMatch(/NOT ruined|no modern technology/i);
  });

  it("style anchor defaults to an AERIAL / drone framing, with a close-up exception", () => {
    expect(LOST_STYLE_ANCHOR).toMatch(/aerial|drone|bird's-eye/i);
    expect(LOST_STYLE_ANCHOR).toMatch(/close|intimate|stream/i);
  });

  it("negative prompt blocks on-screen text, faces, modern tech and ruins", () => {
    expect(LOST_NEGATIVE).toMatch(/text/i);
    expect(LOST_NEGATIVE).toMatch(/face/i);
    expect(LOST_NEGATIVE).toMatch(/modern technology|cars/i);
    expect(LOST_NEGATIVE).toMatch(/ruined|abandoned/i);
  });

  it("scene suggester returns lived-in community ideas", async () => {
    const scenes = await new MockLlmProvider().suggestLostScenes({ count: 8 });
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.join(" ").toLowerCase()).toMatch(/village|homestead|community|hamlet/);
  });

  it("planner returns a still + ONE gentle motion + '#'-prefixed hashtags", async () => {
    const plan = await new MockLlmProvider().planLostScene({ scene: "a misty mountain village at sunrise" });
    expect(plan.stillPrompt.length).toBeGreaterThan(0);
    expect(plan.motionPrompt.length).toBeGreaterThan(0);
    expect(plan.hashtags.every((h) => h.startsWith("#"))).toBe(true);
  });
});
