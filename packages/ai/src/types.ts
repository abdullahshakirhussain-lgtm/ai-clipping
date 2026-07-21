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
  /** Video-level context (who/what this is about) for titles/hashtags. */
  context?: string;
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

// ── Story Studio (generated videos) ─────────────────────────────────────────

/** One narrated beat: a line spoken over one generated image. */
export interface StoryBeat {
  /** Spoken narration for this beat (~1-2 sentences; may carry inline audio tags). */
  text: string;
  /** What the image for this beat depicts (style anchor appended by the caller). */
  imagePrompt: string;
  /** How this beat should be read — pace/pitch/emotion; fed to the TTS per beat. */
  delivery?: string;
}

export interface WriteStoryInput {
  topic: string;
  /** Style preset key (doodle | whiteboard | flat-vector | notebook-sketch). */
  style: string;
  /** How many beats/images to produce. */
  targetBeats: number;
  /** Narrator persona key — shapes the emotional arc the writer directs. */
  narrator?: string;
  /** When true, embed ElevenLabs-v3 audio tags inline in the beat text. */
  voiceTags?: boolean;
}

export interface StoryScript {
  title: string;
  /** Full narration (for reference/debug; beats carry the spoken text). */
  script: string;
  description: string;
  hashtags: string[];
  beats: StoryBeat[];
}

export interface SuggestTopicsInput {
  category?: string;
  count: number;
}

/**
 * Generates images for the story beats. gpt-image-1 in production; a mock draws
 * a solid card so the pipeline runs keyless.
 */
export interface ImageProvider {
  generate(input: { prompt: string; size?: string }): Promise<{ image: Buffer; ext: "png" }>;
}

// ── Commentary track ────────────────────────────────────────────────────────

/** How much commentary a video gets. Chosen per upload. */
export type CommentaryMode = "off" | "intro_outro" | "interject" | "full";

/** Where a commentary line sits. "react" interrupts mid-clip. */
export type CommentaryRole = "intro" | "react" | "outro";

/** Loudness of a line in the final mix (and a hint to the TTS read). */
export type CommentaryIntensity = "quiet" | "normal" | "loud";

/** One spoken line. For "react", `atSec` is a moment in clip-source time. */
export interface CommentaryLine {
  atSec: number;
  text: string;
  role: CommentaryRole;
  /**
   * Voice direction for THIS line, written by the same LLM that wrote the text
   * ("start half-laughing, disbelief building, shout the last word"). Fed to the
   * TTS as `instructions`; absent on pre-M3 scripts, which fall back to the
   * per-role defaults.
   */
  delivery?: string;
  intensity?: CommentaryIntensity;
}

export interface PlanCommentaryInput {
  /** Clip transcript lines prefixed with [start-end] timestamps. */
  transcript: string;
  durationSec: number;
  mode: Exclude<CommentaryMode, "off">;
  category?: string;
  hook?: string;
  /**
   * What we know about the video beyond the transcript: uploader-typed context
   * plus on-screen text read from sampled frames ("Andrew Tate, Fresh&Fit
   * podcast"). Lets the take name who/what it's about.
   */
  context?: string;
  /** Category-level character ("condescending finance guy…"). Overrides the default roast baseline. */
  persona?: string;
  /**
   * When true, write ElevenLabs-v3-style audio tags inline in the text
   * ("[scoffs] Five... [shouting] THE JELLY.") — set from the TTS provider's
   * `speaksTags`. When false the text stays clean prose.
   */
  voiceTags?: boolean;
}

export interface DescribeVideoContextInput {
  /** JPEG frames sampled evenly across the video, chronological order. */
  frames: Buffer[];
  /** Video title (for uploads this is the original filename). */
  title: string | null;
  /** First ~800 chars of the transcript, for cross-referencing names. */
  transcriptSample: string;
}

/**
 * Groups chronologically-ordered frames into batches of `batchSize` where every
 * batch spans the WHOLE timeline (stride interleaving: [0,4,8] [1,5,9] …).
 * The vision loop early-stops after any confident batch, so each batch needs a
 * shot at wherever the title card / watermark happens to be — front-loading
 * chronologically would make a late title card cost all four batches.
 */
export function planVisionBatches<T>(frames: T[], batchSize = 3): T[][] {
  if (frames.length === 0) return [];
  const numBatches = Math.max(1, Math.ceil(frames.length / batchSize));
  const batches: T[][] = Array.from({ length: numBatches }, () => []);
  frames.forEach((f, i) => batches[i % numBatches]!.push(f));
  return batches.filter((b) => b.length > 0);
}

/**
 * Text-to-speech for the commentary voice. `instructions` steers the delivery
 * ("dry, unimpressed, slightly rushed") — the main lever against a read that
 * sounds like a narrator bot. Honoured by OpenAI; ignored by ElevenLabs.
 */
export interface TtsProvider {
  /**
   * True when the provider PERFORMS inline "[tag]"s (ElevenLabs v3 audio tags)
   * instead of reading them aloud. Callers must strip tags before sending text
   * to a provider without this.
   */
  readonly speaksTags?: boolean;
  /** `ext` names the container so the caller can write a file ffmpeg will read. */
  synthesize(input: {
    text: string;
    voice?: string;
    instructions?: string;
  }): Promise<{ audio: Buffer; ext: "mp3" | "wav" }>;
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
  /**
   * Write the spoken commentary for a clip. The point is a real take with a
   * point of view — not narration of what the viewer can already see.
   */
  planCommentary(input: PlanCommentaryInput): Promise<CommentaryLine[]>;
  /**
   * Derive who/what a video is about by READING on-screen text (captions,
   * watermarks, usernames, title cards) from sampled frames — never by face
   * recognition. Batched with early stop to cap vision spend. "" when unknown.
   */
  describeVideoContext(input: DescribeVideoContextInput): Promise<string>;
  enhanceClip(input: EnhanceClipInput): Promise<EnhancementResult>;
  improveHooks(input: { currentHook: string; transcriptExcerpt: string }): Promise<string[]>;
  /** Propose interesting short-form story topics (optionally for a category). */
  suggestStoryTopics(input: SuggestTopicsInput): Promise<string[]>;
  /**
   * Write a narrated story broken into beats, each with an image prompt. The
   * story is the whole product — it must actually be interesting, not filler.
   */
  writeStory(input: WriteStoryInput): Promise<StoryScript>;
}
