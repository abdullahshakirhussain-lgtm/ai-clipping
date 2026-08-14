import { describe, it, expect } from "vitest";
import { lostStillPrompt, LOST_STYLE_ANCHOR, LOST_NEGATIVE, MockLlmProvider } from "@clipfactory/ai";

describe("Lost Chronicles", () => {
  it("still prompt embeds the scene, the locked anime anchor, and forbids on-screen text", () => {
    const p = lostStillPrompt("an ancient library swallowed by a forest");
    expect(p).toContain("an ancient library swallowed by a forest");
    expect(p).toContain("ANIME");
    expect(p.toLowerCase()).toContain("no text");
  });

  it("style anchor keeps the protagonist FACELESS (relatability + Veo person-limit safe)", () => {
    expect(LOST_STYLE_ANCHOR).toMatch(/FACELESS|from BEHIND|never a visible face/i);
  });

  it("negative prompt blocks on-screen text and faces", () => {
    expect(LOST_NEGATIVE).toMatch(/text/i);
    expect(LOST_NEGATIVE).toMatch(/face/i);
  });

  it("planner returns a still + ONE gentle motion + '#'-prefixed hashtags", async () => {
    const plan = await new MockLlmProvider().planLostScene({ scene: "a misty mountain village at sunrise" });
    expect(plan.stillPrompt.length).toBeGreaterThan(0);
    expect(plan.motionPrompt.length).toBeGreaterThan(0);
    expect(plan.hashtags.every((h) => h.startsWith("#"))).toBe(true);
  });
});
