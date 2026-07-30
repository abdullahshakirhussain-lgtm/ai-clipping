import { describe, expect, it } from "vitest";
import { planImageCadence } from "./story-timing.js";

const totalStills = (beats: number[], target: number, max: number) => planImageCadence(beats, target, max).length;
const perBeat = (beats: number[], target: number, max: number) => {
  const counts = new Map<number, number>();
  for (const s of planImageCadence(beats, target, max)) counts.set(s.beatIndex, (counts.get(s.beatIndex) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
};

describe("planImageCadence", () => {
  it("leaves short beats alone", () => {
    expect(perBeat([3, 2.5, 3], 3, 30)).toEqual([1, 1, 1]);
  });

  it("splits a long beat into two shots (the per-beat cap)", () => {
    // A 9s sentence at a 3s target wants 3, but the cap is now 2 — the model
    // can't reliably make more than 2 genuinely-distinct shots of one beat.
    const slides = planImageCadence([9], 3, 30);
    expect(slides).toHaveLength(2);
    for (const s of slides) expect(s.durationSec).toBeCloseTo(4.5, 5);
    expect(slides.map((s) => s.subIndex)).toEqual([0, 1]);
    expect(slides.every((s) => s.subCount === 2)).toBe(true);
  });

  it("preserves total screen time exactly — the video length must not move", () => {
    const beats = [7.4, 2.1, 5.9, 8.8, 1.2];
    const total = beats.reduce((a, b) => a + b, 0);
    const sum = planImageCadence(beats, 3, 30).reduce((a, s) => a + s.durationSec, 0);
    expect(sum).toBeCloseTo(total, 5);
  });

  it("keeps beats in order with their slides contiguous", () => {
    const slides = planImageCadence([8, 3, 6], 3, 30);
    const order = slides.map((s) => s.beatIndex);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("caps one runaway beat at 2 shots instead of letting it eat the budget", () => {
    // 40s on a single beat would want ~13 frames; the per-beat cap is now 2.
    expect(perBeat([40], 3, 30)).toEqual([2]);
  });

  it("spends a tight budget on the longest beats first", () => {
    // Ideal is 1+3+1 = 5 stills, but only 4 are allowed: the long beat keeps
    // its extras because the short ones need them least.
    const counts = perBeat([2, 9, 2], 3, 4);
    expect(counts).toEqual([1, 2, 1]);
    expect(counts.reduce((a, c) => a + c, 0)).toBe(4);
  });

  it("never drops below one still per beat, even under an impossible budget", () => {
    expect(totalStills([5, 5, 5, 5], 3, 1)).toBe(4);
    expect(perBeat([5, 5, 5, 5], 3, 1)).toEqual([1, 1, 1, 1]);
  });

  it("handles the empty case", () => {
    expect(planImageCadence([], 3, 30)).toEqual([]);
  });

  it("turns a ~75s story into roughly one image every 3 seconds", () => {
    // 15 sentences averaging 5s — the shape of a real long-form slideshow.
    const beats = Array.from({ length: 15 }, () => 5);
    const slides = planImageCadence(beats, 3, 30);
    expect(slides.length).toBeGreaterThanOrEqual(24);
    const longest = Math.max(...slides.map((s) => s.durationSec));
    expect(longest).toBeLessThanOrEqual(3.5);
  });
});
