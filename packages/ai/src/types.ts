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

export interface HighlightCandidate {
  startSec: number;
  endSec: number;
  /** Opening line designed to stop the scroll. */
  hook: string;
  /** Why this window was selected. */
  reason: string;
  topic: string;
}

export interface DetectHighlightsInput {
  segments: TranscriptSegment[];
  durationSec: number;
  /** Campaign rules, e.g. { minDurationSec, maxDurationSec, bannedWords } */
  rules?: Record<string, unknown>;
  maxCandidates?: number;
}

export interface EnhanceClipInput {
  transcriptExcerpt: string;
  hook: string;
  topic: string;
  durationSec: number;
  platformHints: string[];
  creatorName?: string;
}

export interface EnhancementResult {
  title: string;
  description: string;
  hashtags: string[];
  hookVariants: string[];
  qualityScore: number;
  viralScore: number;
  estimatedEngagement: number;
  model: string;
}

/** LLM reasoning tasks (Claude in production). */
export interface LlmProvider {
  detectHighlights(input: DetectHighlightsInput): Promise<HighlightCandidate[]>;
  enhanceClip(input: EnhanceClipInput): Promise<EnhancementResult>;
  improveHooks(input: { currentHook: string; transcriptExcerpt: string }): Promise<string[]>;
}
