import { describe, expect, it } from "vitest";
import { splitNarration } from "./narration.js";

/**
 * An 8-minute script is ~1200 spoken words, past what a single TTS request
 * accepts (gpt-4o-mini-tts caps at 2000 input tokens). Sending it in one call
 * is a hard 400, so the split is what makes long-form possible at all.
 */
const sentence = (n: number) => `This is sentence number ${n} and it carries a little detail.`;
const script = (count: number) => Array.from({ length: count }, (_, i) => sentence(i + 1)).join(" ");

describe("splitNarration", () => {
  it("leaves a short narration as a single chunk", () => {
    expect(splitNarration("One sentence. Then another.")).toEqual(["One sentence. Then another."]);
  });

  it("splits a long-form script into TTS-sized pieces", () => {
    const chunks = splitNarration(script(200));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
  });

  it("loses no words — the join is the original narration", () => {
    const text = script(200);
    const rejoined = splitNarration(text).join(" ");
    expect(rejoined.split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it("cuts on sentence boundaries, so joins land where a reader would pause", () => {
    // A chunk ending mid-sentence makes the next chunk start cold and the seam
    // audible; every chunk should end on a terminator.
    for (const c of splitNarration(script(200))) expect(c.trimEnd()).toMatch(/[.!?]["')\]]*$/);
  });

  it("keeps paragraph structure from producing empty chunks", () => {
    const chunks = splitNarration(`${script(40)}\n\n\n${script(40)}`);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it("hard-splits a single sentence longer than the limit rather than emitting it whole", () => {
    const runOn = `${"word ".repeat(2000)}end.`;
    const chunks = splitNarration(runOn);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
  });

  it("returns nothing for empty input rather than a blank chunk", () => {
    expect(splitNarration("   \n\n  ")).toEqual([]);
  });

  it("keeps an 8-minute script within a handful of requests", () => {
    // ~1200 words ≈ 7000 chars — a small number of joins, not dozens.
    const words = 1200;
    const text = Array.from({ length: Math.ceil(words / 11) }, (_, i) => sentence(i + 1)).join(" ");
    const chunks = splitNarration(text);
    expect(chunks.length).toBeLessThanOrEqual(4);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
