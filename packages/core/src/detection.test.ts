import type { HighlightCandidate, TranscriptSegment } from "@clipfactory/ai";
import { describe, expect, it } from "vitest";
import {
  buildAudioCandidates,
  mergeCandidates,
  scoreCandidate,
  selectDiverse,
  type ScoredCandidate,
} from "./detection.js";

/** Build a transcript segment stream at ~2.7 words/sec (ideal talking pace). */
function segmentsFor(startSec: number, endSec: number): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (let t = startSec; t < endSec; t += 5) {
    segs.push({ start: t, end: t + 5, text: "one two three four five six seven eight nine ten eleven twelve thirteen" });
  }
  return segs;
}

/** Flat-ish energy timeline with a loud spike around `peakSec`. */
function energyWithPeak(durationSec: number, peakSec: number): number[] {
  return Array.from({ length: durationSec }, (_, i) => (Math.abs(i - peakSec) <= 2 ? 0.9 : 0.45));
}

describe("scoreCandidate", () => {
  const segments = segmentsFor(0, 120);
  const energy = energyWithPeak(120, 10);

  const strong: HighlightCandidate = {
    startSec: 8,
    endSec: 30, // 22s — inside the ideal band
    hook: "Here's the one mistake everyone makes",
    reason: "bold claim with a clear payoff",
    topic: "mistakes",
    source: "transcript",
    signals: {
      hookType: "curiosity_gap",
      hookStrength: 90,
      frontLoading: 90,
      selfContained: 90,
      emotion: 85,
      loopability: 80,
    },
  };

  const weak: HighlightCandidate = {
    startSec: 60,
    endSec: 130, // 70s — too long
    hook: "um so anyway",
    reason: "meanders",
    topic: "general",
    source: "transcript",
    signals: {
      hookType: "none",
      hookStrength: 20,
      frontLoading: 20,
      selfContained: 25,
      emotion: 20,
      loopability: 20,
    },
  };

  it("scores a strong candidate well above a weak one", () => {
    const s = scoreCandidate({ candidate: strong, segments, energy });
    const w = scoreCandidate({ candidate: weak, segments, energy });
    expect(s.overallScore).toBeGreaterThan(w.overallScore);
    expect(s.overallScore).toBeGreaterThan(70);
    expect(w.overallScore).toBeLessThan(55);
  });

  it("exposes a full, named breakdown (nothing is a black box)", () => {
    const s = scoreCandidate({ candidate: strong, segments, energy });
    expect(s.signals).toMatchObject({
      hookType: expect.any(Number),
      frontLoading: expect.any(Number),
      openingEnergy: expect.any(Number),
      selfContained: expect.any(Number),
      emotion: expect.any(Number),
      pacing: expect.any(Number),
      durationFit: expect.any(Number),
      loopability: expect.any(Number),
    });
    expect(s.notes.length).toBeGreaterThan(0);
  });

  it("rewards a loud opening via the measured energy signal", () => {
    const loudOpen = scoreCandidate({ candidate: { ...strong, startSec: 8 }, segments, energy });
    const quietOpen = scoreCandidate({
      candidate: { ...strong, startSec: 40, endSec: 62 },
      segments,
      energy,
    });
    expect(loudOpen.signals.openingEnergy).toBeGreaterThan(quietOpen.signals.openingEnergy);
  });

  it("scores audio-only candidates (no LLM signals) without throwing", () => {
    const audio: HighlightCandidate = {
      startSec: 8,
      endSec: 30,
      hook: "High-energy moment",
      reason: "audio spike",
      topic: "moment",
      source: "audio",
    };
    const s = scoreCandidate({ candidate: audio, segments, energy });
    expect(s.overallScore).toBeGreaterThan(0);
    expect(s.notes).toContain("audio spike");
  });
});

describe("buildAudioCandidates", () => {
  it("creates windows only for peaks not already covered by transcript clips", () => {
    const existing: HighlightCandidate[] = [
      { startSec: 5, endSec: 25, hook: "x", reason: "y", topic: "t", source: "transcript" },
    ];
    const out = buildAudioCandidates([10, 80], existing, { minDurationSec: 12, maxDurationSec: 60 }, 120);
    // peak 10 is inside the existing clip → skipped; peak 80 → one new window
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("audio");
    expect(out[0]!.startSec).toBeLessThanOrEqual(80);
    expect(out[0]!.endSec).toBeGreaterThan(out[0]!.startSec);
  });
});

describe("selectDiverse", () => {
  const mk = (topic: string, overall: number): ScoredCandidate => ({
    candidate: { startSec: 0, endSec: 20, hook: "h", reason: "r", topic, source: "transcript" },
    score: {
      hookScore: overall,
      viralScore: overall,
      overallScore: overall,
      signals: {} as never,
      measured: {} as never,
      notes: [],
    },
  });

  it("spreads picks across topics instead of taking all of the top topic", () => {
    // Five high-scoring "money" clips and a couple lower "mindset"/"growth" ones.
    const pool: ScoredCandidate[] = [
      mk("money", 95), mk("money", 93), mk("money", 91), mk("money", 90),
      mk("mindset", 80), mk("growth", 78),
    ];
    const picked = selectDiverse(pool, 3);
    const topics = picked.map((p) => p.candidate.topic);
    // Without diversity it'd be money/money/money; the penalty forces a spread.
    expect(new Set(topics).size).toBeGreaterThan(1);
    expect(topics[0]).toBe("money"); // still leads with the best clip
  });

  it("never returns more than max", () => {
    const pool = [mk("a", 90), mk("b", 85), mk("c", 80)];
    expect(selectDiverse(pool, 2)).toHaveLength(2);
  });
});

describe("mergeCandidates", () => {
  it("merges overlapping windows and marks mixed sources hybrid", () => {
    const cands: HighlightCandidate[] = [
      { startSec: 10, endSec: 30, hook: "a", reason: "r", topic: "t", source: "transcript", signals: { hookType: "question", hookStrength: 70, frontLoading: 70, selfContained: 70, emotion: 70, loopability: 70 } },
      { startSec: 25, endSec: 45, hook: "b", reason: "r", topic: "t", source: "audio" },
    ];
    const merged = mergeCandidates(cands, { minDurationSec: 12, maxDurationSec: 60 });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("hybrid");
    expect(merged[0]!.signals).toBeDefined(); // richer (transcript) metadata retained
    expect(merged[0]!.startSec).toBe(10);
    expect(merged[0]!.endSec).toBe(45);
  });
});
