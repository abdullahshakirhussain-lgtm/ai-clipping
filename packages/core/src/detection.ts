import type {
  ClipSignals,
  DetectionSource,
  HighlightCandidate,
  HookType,
  TranscriptSegment,
} from "@clipfactory/ai";

/**
 * Transparent, tunable clip-scoring model.
 *
 * Every clip gets a Hook score ("will the first ~3s stop the scroll?") and a
 * Viral score ("will they finish it and share it?"), each a weighted blend of
 * named sub-signals — some MEASURED from the media (audio energy, words/sec,
 * duration) and some LLM-JUDGED (hook type, self-containment, emotion). Weights
 * live here so they can be tuned; nothing is a black box.
 */
export const SCORING_WEIGHTS = {
  hook: { type: 0.45, frontLoading: 0.3, openingEnergy: 0.25 },
  viral: { selfContained: 0.28, emotion: 0.28, pacing: 0.18, durationFit: 0.14, loopability: 0.12 },
  overall: { hook: 0.5, viral: 0.5 },
} as const;

/** Base strength of each hook shape (0-100), blended 50/50 with the LLM's hookStrength. */
export const HOOK_TYPE_BASE: Record<HookType, number> = {
  curiosity_gap: 95,
  cliffhanger: 92,
  bold_claim: 90,
  controversy: 88,
  question: 85,
  number_list: 80,
  story: 70,
  none: 35,
};

/** Ideal clip length band (seconds) — inside this, durationFit is 100. */
const IDEAL_MIN = 15;
const IDEAL_MAX = 40;
/** Ideal talking pace band (words/sec). */
const IDEAL_WPS_MIN = 1.8;
const IDEAL_WPS_MAX = 3.6;

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const round = (n: number) => Math.round(clamp(n));

export interface ScoreBreakdown {
  hookScore: number;
  viralScore: number;
  overallScore: number;
  /** Named sub-signals behind the two scores (0-100 each). */
  signals: {
    hookType: number;
    frontLoading: number;
    openingEnergy: number;
    selfContained: number;
    emotion: number;
    pacing: number;
    durationFit: number;
    loopability: number;
  };
  /** Raw measured values, for debugging / display. */
  measured: { openingEnergy: number; wordsPerSec: number; energyVariance: number; durationSec: number };
  /** Short human-readable "why" tags for the grid. */
  notes: string[];
}

export interface ScoreCandidateInput {
  candidate: HighlightCandidate;
  segments: TranscriptSegment[];
  /** Per-second normalized (0-1) loudness for the whole source; may be empty. */
  energy: number[];
}

/** Duration fit: 100 inside the ideal band, linear falloff outside, floor 20. */
function durationFit(sec: number): number {
  if (sec >= IDEAL_MIN && sec <= IDEAL_MAX) return 100;
  if (sec < IDEAL_MIN) return clamp(20 + (sec / IDEAL_MIN) * 80);
  // longer than ideal: decay toward 20 by ~90s
  return clamp(100 - ((sec - IDEAL_MAX) / (90 - IDEAL_MAX)) * 80, 20, 100);
}

/** Words/sec fit: 100 inside the ideal band, falloff outside; 50 when no speech. */
function pacingFromWps(wps: number): number {
  if (wps <= 0) return 50; // non-speech window — neutral, energy variance carries pacing
  if (wps >= IDEAL_WPS_MIN && wps <= IDEAL_WPS_MAX) return 100;
  if (wps < IDEAL_WPS_MIN) return clamp(40 + (wps / IDEAL_WPS_MIN) * 60);
  return clamp(100 - (wps - IDEAL_WPS_MAX) * 25, 30, 100);
}

function meanEnergy(energy: number[], fromSec: number, toSec: number): number | null {
  if (energy.length === 0) return null;
  const a = Math.max(0, Math.floor(fromSec));
  const b = Math.min(energy.length, Math.ceil(toSec));
  if (b <= a) return null;
  let sum = 0;
  for (let i = a; i < b; i++) sum += energy[i]!;
  return sum / (b - a);
}

function varianceEnergy(energy: number[], fromSec: number, toSec: number): number | null {
  if (energy.length === 0) return null;
  const a = Math.max(0, Math.floor(fromSec));
  const b = Math.min(energy.length, Math.ceil(toSec));
  if (b - a < 2) return null;
  let sum = 0;
  for (let i = a; i < b; i++) sum += energy[i]!;
  const mean = sum / (b - a);
  let v = 0;
  for (let i = a; i < b; i++) v += (energy[i]! - mean) ** 2;
  return v / (b - a);
}

/** Count spoken words inside a window using the transcript. */
function wordsInWindow(segments: TranscriptSegment[], start: number, end: number): number {
  let words = 0;
  for (const s of segments) {
    if (s.end <= start || s.start >= end) continue;
    words += s.words?.length ?? s.text.trim().split(/\s+/).filter(Boolean).length;
  }
  return words;
}

export function scoreCandidate(input: ScoreCandidateInput): ScoreBreakdown {
  const { candidate, segments, energy } = input;
  const durationSec = Math.max(0, candidate.endSec - candidate.startSec);
  const sig: ClipSignals | undefined = candidate.signals;
  const notes: string[] = [];

  // ── Measured signals ────────────────────────────────────────────────────────
  const openRaw = meanEnergy(energy, candidate.startSec, candidate.startSec + 3);
  const openingEnergy = openRaw === null ? 55 : clamp(openRaw * 100);
  const varRaw = varianceEnergy(energy, candidate.startSec, candidate.endSec);
  // Variance of 0-1 values maxes ~0.25; scale so ~0.05 variance ≈ full marks.
  const energyVariance = varRaw === null ? 50 : clamp((varRaw / 0.05) * 100);
  const words = wordsInWindow(segments, candidate.startSec, candidate.endSec);
  const wps = durationSec > 0 ? words / durationSec : 0;
  const pacing = clamp(0.6 * pacingFromWps(wps) + 0.4 * energyVariance);
  const durFit = durationFit(durationSec);

  // ── LLM-judged signals (or measured-derived fallbacks for audio-only) ────────
  let hookTypeScore: number;
  let frontLoading: number;
  let selfContained: number;
  let emotion: number;
  let loopability: number;

  if (sig) {
    hookTypeScore = 0.5 * HOOK_TYPE_BASE[sig.hookType] + 0.5 * sig.hookStrength;
    frontLoading = sig.frontLoading;
    selfContained = sig.selfContained;
    emotion = sig.emotion;
    loopability = sig.loopability;
    if (sig.hookType !== "none") notes.push(`${sig.hookType.replace("_", " ")} open`);
    if (sig.emotion >= 70) notes.push("high emotion");
  } else {
    // Pure audio-energy candidate: the loud moment IS the hook.
    hookTypeScore = openingEnergy;
    frontLoading = 60;
    selfContained = 45;
    emotion = clamp(openingEnergy * 1.05 + energyVariance * 0.15);
    loopability = 50;
    notes.push("audio spike");
  }

  if (openingEnergy >= 70) notes.push("loud open");
  if (energyVariance < 25 && energy.length > 0) notes.push("some dead air");
  if (durationSec >= IDEAL_MIN && durationSec <= IDEAL_MAX) notes.push(`tight ${Math.round(durationSec)}s`);

  const w = SCORING_WEIGHTS;
  const hookScore =
    w.hook.type * hookTypeScore + w.hook.frontLoading * frontLoading + w.hook.openingEnergy * openingEnergy;
  const viralScore =
    w.viral.selfContained * selfContained +
    w.viral.emotion * emotion +
    w.viral.pacing * pacing +
    w.viral.durationFit * durFit +
    w.viral.loopability * loopability;
  const overallScore = w.overall.hook * hookScore + w.overall.viral * viralScore;

  return {
    hookScore: round(hookScore),
    viralScore: round(viralScore),
    overallScore: round(overallScore),
    signals: {
      hookType: round(hookTypeScore),
      frontLoading: round(frontLoading),
      openingEnergy: round(openingEnergy),
      selfContained: round(selfContained),
      emotion: round(emotion),
      pacing: round(pacing),
      durationFit: round(durFit),
      loopability: round(loopability),
    },
    measured: {
      openingEnergy: Number(openingEnergy.toFixed(1)),
      wordsPerSec: Number(wps.toFixed(2)),
      energyVariance: Number(energyVariance.toFixed(1)),
      durationSec: Number(durationSec.toFixed(1)),
    },
    notes,
  };
}

// ── Candidate assembly ─────────────────────────────────────────────────────────

export interface DetectionBounds {
  minDurationSec: number;
  maxDurationSec: number;
}

/**
 * Turn audio-energy peaks that AREN'T already covered by a transcript candidate
 * into their own clip windows (non-speech highlights: laughs, hype, action).
 */
export function buildAudioCandidates(
  peaks: number[],
  existing: HighlightCandidate[],
  bounds: DetectionBounds,
  durationSec: number,
): HighlightCandidate[] {
  const len = Math.min(bounds.maxDurationSec, Math.max(bounds.minDurationSec, 28));
  const out: HighlightCandidate[] = [];
  for (const peak of peaks) {
    // Skip peaks that fall inside a window we already have.
    if (existing.some((c) => peak >= c.startSec - 2 && peak <= c.endSec + 2)) continue;
    if (out.some((c) => peak >= c.startSec && peak <= c.endSec)) continue;
    const start = Math.max(0, Math.min(peak - len * 0.3, durationSec - len));
    const end = Math.min(durationSec, start + len);
    if (end - start < bounds.minDurationSec) continue;
    out.push({
      startSec: Number(start.toFixed(2)),
      endSec: Number(end.toFixed(2)),
      hook: "High-energy moment",
      reason: "Audio-energy spike (reaction / action / hype)",
      topic: "moment",
      source: "audio",
    });
  }
  return out;
}

export interface ScoredCandidate {
  candidate: HighlightCandidate;
  score: ScoreBreakdown;
}

/**
 * Diversity-aware selection (MMR-style): pick best-scored clips but penalize
 * repeated topics so one long video yields a *spread* of clips, not five
 * variations of the same moment. `pool` must be pre-sorted best-first.
 */
export function selectDiverse(pool: ScoredCandidate[], max: number, topicPenalty = 8): ScoredCandidate[] {
  const remaining = [...pool];
  const picked: ScoredCandidate[] = [];
  const topicCount = new Map<string, number>();
  while (picked.length < max && remaining.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const it = remaining[i]!;
      const used = topicCount.get(it.candidate.topic) ?? 0;
      const adjusted = it.score.overallScore - used * topicPenalty;
      if (adjusted > bestVal) {
        bestVal = adjusted;
        bestIdx = i;
      }
    }
    const [chosen] = remaining.splice(bestIdx, 1);
    picked.push(chosen!);
    const t = chosen!.candidate.topic;
    topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
  }
  return picked;
}

/** Merge overlapping candidate windows so we don't render near-duplicates. */
export function mergeCandidates(
  candidates: HighlightCandidate[],
  bounds: DetectionBounds,
): HighlightCandidate[] {
  const sorted = [...candidates].sort((a, b) => a.startSec - b.startSec);
  const merged: HighlightCandidate[] = [];
  for (const c of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && c.startSec < prev.endSec) {
      // Overlap: extend the window (bounded by maxDuration) and keep the richer metadata.
      const start = prev.startSec;
      const end = Math.min(Math.max(prev.endSec, c.endSec), start + bounds.maxDurationSec);
      const withSignals = prev.signals ? prev : c.signals ? c : prev;
      const source: DetectionSource =
        prev.source === c.source ? prev.source : "hybrid";
      merged[merged.length - 1] = {
        ...withSignals,
        startSec: start,
        endSec: end,
        source,
      };
    } else {
      merged.push(c);
    }
  }
  return merged;
}
