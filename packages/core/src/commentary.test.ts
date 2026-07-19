import { MockLlmProvider, MockTtsProvider, planVisionBatches, type TtsProvider } from "@clipfactory/ai";
import { describe, expect, it } from "vitest";
import { makeTtsFor } from "./container.js";
import { CommentaryLineSchema } from "./contracts/clip.js";
import { assembleContext, INTENSITY_GAIN, reactFreezeSourceSec, stripAudioTags } from "./pipeline/stages.js";

/**
 * M3 gave each line a performance (delivery direction + intensity). These fields
 * ride the edl through save/re-render, so losing them anywhere in the round-trip
 * silently flattens the read back to "same pitch throughout".
 */
describe("commentary performance fields", () => {
  it("round-trips delivery and intensity through the contract schema", () => {
    const line = {
      atSec: 12.5,
      text: "He said guaranteed. TWICE.",
      role: "react" as const,
      delivery: "Disbelief building fast, shout the last word.",
      intensity: "loud" as const,
    };
    expect(CommentaryLineSchema.parse(line)).toEqual(line);
  });

  it("still accepts pre-M3 lines without the new fields", () => {
    const legacy = { atSec: 0, text: "Okay, context first.", role: "intro" as const };
    const parsed = CommentaryLineSchema.parse(legacy);
    expect(parsed.delivery).toBeUndefined();
    expect(parsed.intensity).toBeUndefined();
  });

  it("rejects an unknown intensity instead of passing it to the mixer", () => {
    expect(() =>
      CommentaryLineSchema.parse({ atSec: 0, text: "hi", role: "intro", intensity: "screaming" }),
    ).toThrow();
  });

  it("maps intensity to mix gain with loud above and quiet below unity", () => {
    expect(INTENSITY_GAIN.loud).toBeGreaterThan(1);
    expect(INTENSITY_GAIN.quiet).toBeLessThan(1);
    expect(INTENSITY_GAIN.normal).toBe(1);
    // The pipeline falls back to unity for absent/unknown intensities.
    expect(INTENSITY_GAIN["screaming"] ?? 1).toBe(1);
  });

  it("strips audio tags for providers that would read them aloud", () => {
    expect(stripAudioTags("[scoffs] Five Lamborghinis... [shouting] THE JELLY.")).toBe(
      "Five Lamborghinis... THE JELLY.",
    );
    // Adjacent tags and mid-word spacing collapse cleanly.
    expect(stripAudioTags("[sighs][pause] Fine. He wins.")).toBe("Fine. He wins.");
    // Bracket-free text passes through untouched.
    expect(stripAudioTags("He said guaranteed. TWICE.")).toBe("He said guaranteed. TWICE.");
    // A tags-only line strips to empty — the pipeline skips it instead of TTS-ing "".
    expect(stripAudioTags("[laughs] [sighs]")).toBe("");
    // Oversized brackets (>30 chars) are treated as speech, not a tag.
    const notATag = "[this is a long bracketed aside that is definitely not an audio tag]";
    expect(stripAudioTags(notATag)).toBe(notATag);
  });

  it("routes voice tiers: premium only on explicit request, standard for everything else", () => {
    const standard = new MockTtsProvider();
    const premium: TtsProvider = { speaksTags: true, synthesize: () => Promise.reject(new Error("unused")) };
    const ttsFor = makeTtsFor({ standard, premium });
    expect(ttsFor("premium")).toBe(premium);
    expect(ttsFor("standard")).toBe(standard);
    // Unknown/legacy tier strings must never spend premium credits.
    expect(ttsFor("")).toBe(standard);
    expect(ttsFor("gold")).toBe(standard);
  });

  it("premium tier falls back to standard when ElevenLabs isn't configured", () => {
    // The container wires premium = standard in that case; same-instance means
    // the Library button degrades to a no-op re-render instead of crashing.
    const standard = new MockTtsProvider();
    const ttsFor = makeTtsFor({ standard, premium: standard });
    expect(ttsFor("premium")).toBe(standard);
  });

  it("mock planner emits audio tags only when the provider speaks them", async () => {
    const llm = new MockLlmProvider();
    const base = { transcript: "[0.0-5.0] test", durationSec: 30, mode: "interject" as const };
    const tagged = await llm.planCommentary({ ...base, voiceTags: true });
    const clean = await llm.planCommentary({ ...base, voiceTags: false });
    expect(tagged.some((l) => /\[[^\]]+\]/.test(l.text))).toBe(true);
    expect(clean.some((l) => /\[[^\]]+\]/.test(l.text))).toBe(false);
    // The tagged line still has words left after stripping (never tags-only).
    for (const l of tagged) expect(stripAudioTags(l.text).length).toBeGreaterThan(0);
  });

  it("assembles video context with the uploader's words first", () => {
    expect(assembleContext("Tate on Fresh&Fit", "Watermark reads @freshfit")).toBe(
      "Tate on Fresh&Fit\nWatermark reads @freshfit",
    );
    expect(assembleContext("Tate on Fresh&Fit", null)).toBe("Tate on Fresh&Fit");
    expect(assembleContext(null, "Watermark reads @freshfit")).toBe("Watermark reads @freshfit");
    // Empty/whitespace on both sides means the prompt block is omitted entirely.
    expect(assembleContext("  ", null)).toBeUndefined();
    expect(assembleContext(null, undefined)).toBeUndefined();
  });

  it("interleaves vision batches so each batch spans the whole timeline", () => {
    const frames = Array.from({ length: 12 }, (_, i) => i);
    const batches = planVisionBatches(frames, 3);
    expect(batches).toEqual([
      [0, 4, 8],
      [1, 5, 9],
      [2, 6, 10],
      [3, 7, 11],
    ]);
    // Every frame used exactly once.
    expect(batches.flat().sort((a, b) => a - b)).toEqual(frames);
    // Short videos (fewer frames) still batch without loss or empties.
    const seven = planVisionBatches([0, 1, 2, 3, 4, 5, 6], 3);
    expect(seven.flat().sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const b of seven) expect(b.length).toBeGreaterThan(0);
    expect(planVisionBatches([], 3)).toEqual([]);
  });

  it("mock vision context is empty so the keyless pipeline skips the block", async () => {
    const llm = new MockLlmProvider();
    await expect(
      llm.describeVideoContext({ frames: [Buffer.alloc(0)], title: "x.mp4", transcriptSample: "" }),
    ).resolves.toBe("");
  });

  it("snaps a react freeze to AFTER the beat it reacts to (anti-spoiler)", () => {
    // Clip runs source 100..140; react atSec 12 -> source 112, inside [110,116].
    const segments = [
      { start: 100, end: 106 },
      { start: 108, end: 116 },
      { start: 120, end: 130 },
    ];
    // Lands at the segment END (116), never before it — the line has finished.
    expect(reactFreezeSourceSec(segments, 100, 140, 12)).toBe(116);
    // A react over the last segment snaps to its end too.
    expect(reactFreezeSourceSec(segments, 100, 140, 25)).toBe(130);
    // No segment at that moment (non-speech gap): fall back to the raw time.
    expect(reactFreezeSourceSec(segments, 100, 140, 18)).toBe(118);
    // Never escapes the clip window (far-past-end clamps to the clip end).
    expect(reactFreezeSourceSec(segments, 100, 140, 999)).toBe(140);
    // A negative atSec clamps to the clip start (source 100), which falls inside
    // the first segment, so it still snaps to that segment's end.
    expect(reactFreezeSourceSec(segments, 100, 140, -5)).toBe(106);
  });

  it("mock planner directs every line so the keyless pipeline exercises the path", async () => {
    const llm = new MockLlmProvider();
    const lines = await llm.planCommentary({
      transcript: "[0.0-5.0] test",
      durationSec: 30,
      mode: "full",
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.delivery).toBeTruthy();
      expect(["quiet", "normal", "loud"]).toContain(l.intensity);
    }
    // Directions vary per line — identical direction everywhere is the old bug.
    expect(new Set(lines.map((l) => l.delivery)).size).toBe(lines.length);
    expect(new Set(lines.map((l) => l.intensity)).size).toBeGreaterThan(1);
  });
});
