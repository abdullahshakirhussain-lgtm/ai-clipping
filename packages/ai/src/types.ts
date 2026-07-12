export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
  /** Speaker label when the transcription provider diarizes (e.g. "0", "1"). */
  speaker?: string;
}

export interface TranscriptionResult {
  language: string;
  text: string;
  segments: TranscriptSegment[];
  provider: string;
}

/** Speech-to-text with timestamps (Groq Whisper in production). */
export interface TranscriptionProvider {
  transcribe(localFilePath: string): Promise<TranscriptionResult>;
}

/** Categorical opening-hook shape the LLM classifies for each candidate. */
export type HookType =
  | "question"
  | "bold_claim"
  | "curiosity_gap"
  | "number_list"
  | "controversy"
  | "cliffhanger"
  | "story"
  | "none";

/**
 * LLM-judged qualities of a candidate clip (0-100 unless noted). These feed the
 * transparent scoring model in packages/core alongside measured audio signals.
 */
export interface ClipSignals {
  hookType: HookType;
  /** How strong the opening line itself is. */
  hookStrength: number;
  /** Payoff lands in the first ~3s vs buried later. */
  frontLoading: number;
  /** Makes sense with zero context and actually resolves. */
  selfContained: number;
  /** Funny / shocking / insightful / satisfying intensity. */
  emotion: number;
  /** Rewatch / replay / stitch potential. */
  loopability: number;
}

/** Where a candidate window came from. */
export type DetectionSource = "transcript" | "audio" | "hybrid";

export interface HighlightCandidate {
  startSec: number;
  endSec: number;
  /** Opening line designed to stop the scroll. */
  hook: string;
  /** Why this window was selected. */
  reason: string;
  topic: string;
  source: DetectionSource;
  /** LLM sub-scores; absent for pure audio-energy candidates. */
  signals?: ClipSignals;
}

export interface DetectHighlightsInput {
  segments: TranscriptSegment[];
  durationSec: number;
  minDurationSec: number;
  maxDurationSec: number;
  /** Transcript is chunked into windows of this many minutes per LLM call. */
  chunkMinutes: number;
  /** Optional audio-energy peak timestamps (seconds) fed to the LLM as hints. */
  audioPeaks?: number[];
}

export interface EnhanceClipInput {
  transcriptExcerpt: string;
  hook: string;
  topic: string;
  durationSec: number;
  platformHints: string[];
  creatorName?: string;
}

/** Metadata only — scoring is computed in packages/core, not here. */
export interface EnhancementResult {
  title: string;
  description: string;
  hashtags: string[];
  hookVariants: string[];
  model: string;
}

export interface RefineHighlightsInput {
  clips: Array<{
    index: number;
    hook: string;
    transcript: string;
    durationSec: number;
  }>;
}

/** Sound effects available for auto-enhancement. */
export type SfxSound = "whoosh" | "boom" | "faaaaa";

/** A single SFX cue placed at a clip-source-time moment. */
export interface SfxCue {
  /** Seconds within the clip window (source time). */
  atSec: number;
  sound: SfxSound;
  reason: string;
}

export interface PlanEnhancementsInput {
  /** Clip transcript lines prefixed with [start-end] timestamps. */
  transcript: string;
  durationSec: number;
  /** Hard ceiling on cues (restraint). */
  maxCues: number;
}

/** LLM reasoning tasks (Claude in production). */
export interface LlmProvider {
  detectHighlights(input: DetectHighlightsInput): Promise<HighlightCandidate[]>;
  /**
   * Self-critique pass: given a shortlist, return the indices worth keeping —
   * drops clips that look good on paper but don't stand alone or don't pay off.
   */
  refineHighlights(input: RefineHighlightsInput): Promise<number[]>;
  /**
   * Sparingly place sound-effect cues. Restraint is the goal — most clips get
   * zero. "faaaaa" is reserved for genuinely absurd/dumb statements.
   */
  planEnhancements(input: PlanEnhancementsInput): Promise<SfxCue[]>;
  enhanceClip(input: EnhanceClipInput): Promise<EnhancementResult>;
  improveHooks(input: { currentHook: string; transcriptExcerpt: string }): Promise<string[]>;
}
