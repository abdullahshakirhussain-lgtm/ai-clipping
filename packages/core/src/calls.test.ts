import {
  buildCallBrief,
  GEMINI_VOICES,
  MockCallProvider,
  MockLlmProvider,
  parseLines,
  pcmToWav,
  resolveVoice,
} from "@clipfactory/ai";
import { describe, expect, it } from "vitest";

const plan = async () => new MockLlmProvider().planCall({ idea: "rage bait a scammer", maxSeconds: 45 });

describe("buildCallBrief", () => {
  it("carries every field the improvisation must not get wrong", async () => {
    const p = await plan();
    const brief = buildCallBrief(p);
    expect(brief).toContain(p.premise);
    expect(brief).toContain(p.setup);
    expect(brief).toContain(p.ending);
    for (const c of p.characters) {
      expect(brief).toContain(c.name);
      expect(brief).toContain(c.accent);
      expect(brief).toContain(c.voice);
      expect(brief).toContain(c.agenda);
      expect(brief).toContain(c.quirks);
    }
    for (const beat of p.escalation) expect(brief).toContain(beat);
    for (const bait of p.ragebait) expect(brief).toContain(bait);
  });

  it("always states the fictional/no-real-people guardrail", async () => {
    const brief = buildCallBrief(await plan());
    expect(brief).toContain("FICTIONAL");
    expect(brief).toMatch(/no real people/i);
  });

  it("is deterministic — the preview is byte-identical to what gets sent", async () => {
    const p = await plan();
    expect(buildCallBrief(p)).toBe(buildCallBrief(p));
  });
});

describe("resolveVoice", () => {
  it("keeps a real voice id", () => {
    expect(resolveVoice("Kore", "female")).toBe("Kore");
  });

  it("falls back to a same-gender voice when the planner invents one", () => {
    const picked = resolveVoice("NotAVoice", "male", 2);
    const found = GEMINI_VOICES.find((v) => v.name === picked);
    expect(found?.gender).toBe("male");
  });

  it("never returns an unusable id (a bad name would 400 the TTS call)", () => {
    const names = new Set(GEMINI_VOICES.map((v) => v.name));
    for (const bad of ["", "  ", "kore", "Charon2"]) {
      expect(names.has(resolveVoice(bad, "female"))).toBe(true);
    }
  });
});

describe("parseLines", () => {
  it("drops a preamble, strips emphasis, and folds unlabelled continuations", () => {
    const text = [
      "Here's the call:",
      "**Dave:** listen to me",
      "Priya: I understand your frustration.",
      "and another thing",
      "> Dave: hello? hello?",
    ].join("\n");
    expect(parseLines(text, ["Dave", "Priya"])).toEqual([
      { speaker: "Dave", text: "listen to me" },
      { speaker: "Priya", text: "I understand your frustration. and another thing" },
      { speaker: "Dave", text: "hello? hello?" },
    ]);
  });

  it("matches speaker labels case-insensitively but emits the canonical name", () => {
    expect(parseLines("dave: yeah", ["Dave", "Priya"])).toEqual([{ speaker: "Dave", text: "yeah" }]);
  });

  it("returns nothing usable when the model ignored the format", () => {
    expect(parseLines("I cannot help with that request.", ["Dave", "Priya"]).length).toBeLessThan(2);
  });
});

describe("pcmToWav", () => {
  it("writes a RIFF/WAVE header whose sizes match the payload", () => {
    const pcm = Buffer.alloc(4800); // 0.1s of 24kHz mono 16-bit
    const wav = pcmToWav(pcm, 24000);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(24000 * 2); // byte rate, mono 16-bit
    expect(wav.length).toBe(44 + pcm.length);
  });
});

describe("MockCallProvider", () => {
  it("returns a playable wav and labelled lines so the pipeline runs keyless", async () => {
    const p = await plan();
    const call = await new MockCallProvider().generate({
      brief: buildCallBrief(p),
      speakers: p.characters.map((c) => ({ name: c.name, voice: c.voice, direction: c.accent })),
      targetSeconds: p.durationSeconds,
    });
    expect(call.ext).toBe("wav");
    expect(call.audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(call.lines.length).toBeGreaterThan(1);
    expect(call.lines.every((l) => p.characters.some((c) => c.name === l.speaker))).toBe(true);
  });
});
