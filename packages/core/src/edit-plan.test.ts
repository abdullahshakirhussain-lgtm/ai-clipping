import { planClipEdit, type CaptionWord } from "@clipfactory/media";
import { describe, expect, it } from "vitest";

/** Build evenly-spaced words, each 0.4s long starting every `stepSec`. */
function words(spec: Array<{ w: string; at: number; dur?: number }>): CaptionWord[] {
  return spec.map((s) => ({ word: s.w, start: s.at, end: s.at + (s.dur ?? 0.4) }));
}

describe("planClipEdit", () => {
  it("removes an internal dead-air gap and re-times later words", () => {
    // "hello world" at 0-1s, then 3s of silence, then "again now" at 4s.
    const w = words([
      { w: "hello", at: 0 },
      { w: "world", at: 0.5 },
      { w: "again", at: 4.0 },
      { w: "now", at: 4.5 },
    ]);
    const plan = planClipEdit({ words: w, clipStart: 0, clipEnd: 5, maxGapSec: 0.4 });
    // The ~3s gap between "world" (ends 0.9) and "again" (4.0) should be cut.
    expect(plan.removedSec).toBeGreaterThan(2.5);
    expect(plan.clipDurationSec).toBeLessThan(2.5);
    // Two keep spans (before and after the gap).
    expect(plan.selectSpans.length).toBe(2);
  });

  it("trims leading filler words so the clip opens on the hook", () => {
    const w = words([
      { w: "um", at: 0 },
      { w: "so", at: 0.5 },
      { w: "listen", at: 1.0 },
      { w: "carefully", at: 1.5 },
    ]);
    const plan = planClipEdit({ words: w, clipStart: 0, clipEnd: 3 });
    // The first kept content is "listen", so the first span starts near 1.0s.
    expect(plan.selectSpans[0]!.s).toBeGreaterThan(0.7);
    expect(plan.ass.toUpperCase()).toContain("LISTEN");
    expect(plan.ass.toUpperCase()).not.toContain("UM ");
  });

  it("emits karaoke captions (\\k tags) plus a hook banner", () => {
    const w = words([
      { w: "this", at: 0 },
      { w: "changes", at: 0.5 },
      { w: "everything", at: 1.0 },
    ]);
    const plan = planClipEdit({ words: w, clipStart: 0, clipEnd: 3, hookText: "Watch this" });
    expect(plan.ass).toContain("Style: Karaoke");
    expect(plan.ass).toContain("Style: Hook");
    expect(plan.ass).toMatch(/\\k\d+/); // per-word karaoke timing
    expect(plan.ass.toUpperCase()).toContain("WATCH THIS");
  });

  it("degrades gracefully with no words (non-speech clip)", () => {
    const plan = planClipEdit({ words: [], clipStart: 10, clipEnd: 40 });
    expect(plan.selectSpans).toEqual([{ s: 0, e: 30 }]); // single full span → no cuts
    expect(plan.removedSec).toBe(0);
    expect(plan.ass).toBe(""); // nothing to caption
  });
});
