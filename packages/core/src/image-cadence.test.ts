import { describe, expect, it } from "vitest";
import { planImageCadence, type CadenceOpts } from "./story-timing.js";

const totalStills = (beats: number[], target: number, max: number, opts?: CadenceOpts) =>
  planImageCadence(beats, target, max, opts).length;
const perBeat = (beats: number[], target: number, max: number, opts?: CadenceOpts) => {
  const counts = new Map<number, number>();
  for (const s of planImageCadence(beats, target, max, opts)) counts.set(s.beatIndex, (counts.get(s.beatIndex) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
};

describe("planImageCadence", () => {
  it("leaves short beats alone", () => {
    expect(perBeat([3, 2.5, 3], 3, 30)).toEqual([1, 1, 1]);
  });

  it("splits a long beat into three shots (the per-beat cap)", () => {
    // A 9s sentence at a 3s target wants 3, and the cap is now 3 — the splitter
    // reliably makes three distinct framings (wide → closer → detail) of a beat.
    const slides = planImageCadence([9], 3, 30);
    expect(slides).toHaveLength(3);
    for (const s of slides) expect(s.durationSec).toBeCloseTo(3, 5);
    expect(slides.map((s) => s.subIndex)).toEqual([0, 1, 2]);
    expect(slides.every((s) => s.subCount === 3)).toBe(true);
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

  it("caps one runaway beat at 3 shots instead of letting it eat the budget", () => {
    // 40s on a single beat would want ~13 frames; the per-beat cap is now 3.
    expect(perBeat([40], 3, 30)).toEqual([3]);
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

  it("fast open: beats that start inside the window get denser, later beats don't", () => {
    // beat starts: 0, 4, 9. A 6s window covers the first two only.
    const beats = [4, 5, 6];
    const normal = perBeat(beats, 3, 100);
    const opened = perBeat(beats, 3, 100, { openSeconds: 6 });
    expect(opened[0]!).toBeGreaterThan(normal[0]!); // first beat is packed tighter
    expect(opened[2]!).toBe(normal[2]!); // beat starting at t=9 is untouched
    // The opening slides are genuinely fast (well under the normal 3s target).
    const firstBeatSlides = planImageCadence(beats, 3, 100, { openSeconds: 6 }).filter((s) => s.beatIndex === 0);
    expect(Math.max(...firstBeatSlides.map((s) => s.durationSec))).toBeLessThanOrEqual(2);
  });

  it("fast open never overruns the total screen time", () => {
    const beats = [3.5, 4.2, 5, 6, 7];
    const total = beats.reduce((a, b) => a + b, 0);
    const sum = planImageCadence(beats, 3, 100, { openSeconds: 6 }).reduce((a, s) => a + s.durationSec, 0);
    expect(sum).toBeCloseTo(total, 5);
  });

  it("long form (~8min) reaches ~3s cadence via the per-beat split, within budget", () => {
    // ~55 beats averaging ~9s ≈ 8 minutes — long form can't have hundreds of
    // beats, so the 3-way split is what carries it to a swipe-feed pace.
    const beats = Array.from({ length: 55 }, () => 9);
    const total = beats.reduce((a, b) => a + b, 0); // 495s
    const slides = planImageCadence(beats, 3, 220);
    expect(slides.length).toBeLessThanOrEqual(220); // inside STORY_MAX_IMAGES
    expect(total / slides.length).toBeLessThanOrEqual(3.2); // ~one image every ~3s
  });
});
