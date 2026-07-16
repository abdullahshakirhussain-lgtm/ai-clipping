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

  it("places captions per the selected position (ASS alignment)", () => {
    const w = words([{ w: "top", at: 0 }, { w: "line", at: 0.5 }]);
    const top = planClipEdit({ words: w, clipStart: 0, clipEnd: 3, position: "top" });
    const bottom = planClipEdit({ words: w, clipStart: 0, clipEnd: 3, position: "bottom" });
    // Karaoke style line ends with "...,<alignment>,ML,MR,MV,1"; alignment 8=top, 2=bottom.
    expect(top.ass).toMatch(/Style: Karaoke,[^\n]*,8,60,60,\d+,1/);
    expect(bottom.ass).toMatch(/Style: Karaoke,[^\n]*,2,60,60,\d+,1/);
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

  // Repost/untouched mode. Regression guard: the normal path re-times words into
  // POST-CUT time, so reusing that plan for an uncut render drifts the subtitles
  // out of sync. noCuts must keep captions on the linear source timeline.
  describe("noCuts (repost mode)", () => {
    /** Dialogue start times, in seconds, from an ASS script. */
    function dialogueStarts(ass: string): number[] {
      return [...ass.matchAll(/Dialogue: \d+,\d:(\d\d):(\d\d\.\d\d),/g)].map(
        (m) => Number(m[1]) * 60 + Number(m[2]),
      );
    }

    const gapped = words([
      { w: "hello", at: 0 },
      { w: "world", at: 0.5 },
      { w: "again", at: 4.0 },
      { w: "now", at: 4.5 },
    ]);

    it("keeps the whole window and removes nothing", () => {
      const plan = planClipEdit({ words: gapped, clipStart: 0, clipEnd: 5, noCuts: true });
      expect(plan.selectSpans).toEqual([{ s: 0, e: 5 }]);
      expect(plan.removedSec).toBe(0);
      expect(plan.clipDurationSec).toBe(5);
    });

    it("times captions on the uncut timeline, unlike the cutting path", () => {
      const opts = { words: gapped, clipStart: 0, clipEnd: 5, maxGapSec: 0.4, wordsPerLine: 2 };
      const cut = planClipEdit(opts);
      const uncut = planClipEdit({ ...opts, noCuts: true });
      // "again" really happens at 4s. Cutting the 3s gap pulls it early…
      expect(Math.max(...dialogueStarts(cut.ass))).toBeLessThan(2);
      // …but an untouched render must caption it at its true ~4s position.
      expect(Math.max(...dialogueStarts(uncut.ass))).toBeGreaterThan(3.5);
    });

    it("does not trim leading filler", () => {
      const w = words([
        { w: "um", at: 0 },
        { w: "so", at: 0.5 },
        { w: "listen", at: 1.0 },
      ]);
      const plan = planClipEdit({ words: w, clipStart: 0, clipEnd: 3, noCuts: true });
      expect(plan.selectSpans).toEqual([{ s: 0, e: 3 }]);
      expect(plan.ass.toUpperCase()).toContain("UM");
    });
  });

  it("degrades gracefully with no words (non-speech clip)", () => {
    const plan = planClipEdit({ words: [], clipStart: 10, clipEnd: 40 });
    expect(plan.selectSpans).toEqual([{ s: 0, e: 30 }]); // single full span → no cuts
    expect(plan.removedSec).toBe(0);
    expect(plan.ass).toBe(""); // nothing to caption
  });
});
