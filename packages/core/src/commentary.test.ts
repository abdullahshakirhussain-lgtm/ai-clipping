import { MockLlmProvider, MockTtsProvider, type TtsProvider } from "@clipfactory/ai";
import { describe, expect, it } from "vitest";
import { makeTtsFor } from "./container.js";
import { CommentaryLineSchema } from "./contracts/clip.js";
import { INTENSITY_GAIN, stripAudioTags } from "./pipeline/stages.js";

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
