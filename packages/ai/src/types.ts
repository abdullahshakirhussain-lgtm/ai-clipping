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
  /** Optional free-text direction from the user (what to mention/avoid, angle,
   *  tone). Honoured on top of the doctrine, without overriding the hard rules. */
  direction?: string;
  /**
   * "scenario" (default) = immersive second-person explainer of how something
   * actually was (no dramatic twist needed). "story" = a specific dramatic true
   * story with a hook and a turn. Shapes both the architect and narrator passes.
   */
  mode?: "scenario" | "story";
  /** HERO channel: the fixed protagonist's name. When set, the scenario is a
   *  peaceful day in a DIFFERENT life for this same named man ("you, [Name], …");
   *  when absent, the stick channel's name-less "you" opening stands. */
  protagonistName?: string;
  /** Explicit format so the writer doesn't have to guess it from word counts:
   *  "long" wants many full-sentence beats; "short" wants a few tiny ones. */
  length?: "long" | "short";
  /** Style preset key (doodle | whiteboard | flat-vector | notebook-sketch). */
  style: string;
  /** CEILING on images/beats (cost + cadence cap); the writer uses as many as the story needs. */
  maxBeats: number;
  /** CEILING on spoken words (~2-min cap); shorter is fine — length follows the story. */
  maxWords: number;
  /**
   * FLOOR on beats. Set where one beat maps to one paid clip (animation), so
   * the writer can't hand back a 5-beat story and quietly halve the runtime.
   */
  minBeats?: number;
  /**
   * FLOOR on spoken words. Every format now targets over a minute (~150 wpm),
   * and without a floor the writer is told shorter is better and obliges.
   */
  minWords?: number;
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
  /**
   * The story's locked VISUAL WORLD — a compact, concrete description of the
   * place, era and recurring character/motifs this story lives in (e.g. "snowy
   * Moscow, red Kremlin walls, Cyrillic signs, ushanka hats, grey Soviet
   * blocks; recurring man in a brown coat"). Threaded into EVERY beat's image
   * prompt so frames read as one coherent, unmistakably on-topic world instead
   * of context-free figures. May be empty if the writer omitted it.
   */
  setting: string;
  beats: StoryBeat[];
}

export interface ExpandImagePromptsInput {
  /** The story's locked visual world, so the extra frames stay on-topic. */
  setting: string;
  /** Style key — only needed so the FPV style ("anime-fpv") keeps the shots in
   *  first-person; omit/other keys use the normal third-person framing. */
  style?: string;
  /** Beats needing more than one still: the spoken line, the base prompt, how many. */
  beats: Array<{ text: string; imagePrompt: string; count: number }>;
}

export interface RefineImagePromptsInput {
  topic: string;
  /** The story's locked visual world, threaded into every prompt. */
  setting: string;
  /** Style key (e.g. "stick-openai") — the caller appends the art anchor after. */
  style: string;
  /** The finished beats, in order. Only the spoken line is needed. */
  beats: Array<{ text: string; imagePrompt?: string }>;
}

/**
 * The cheap text tasks — topic brainstorming and the dedicated tight-image-prompt
 * pass — that can run on a budget model (DeepSeek V4 Flash) instead of the Opus
 * writer. Any {@link LlmProvider} also satisfies this, so it's the graceful
 * fallback when no cheap model is configured.
 */
export interface CheapTextProvider {
  suggestStoryTopics(input: SuggestTopicsInput): Promise<string[]>;
  /** One tight, on-topic image prompt per beat, in order (length === beats.length). */
  refineImagePrompts(input: RefineImagePromptsInput): Promise<string[]>;
  /** Split each long beat into N DISTINCT shot prompts. Mechanical fan-out — runs
   *  on the budget model; the main LLM implements it too, as the fallback. */
  expandImagePrompts(input: ExpandImagePromptsInput): Promise<string[][]>;
}

// ── Animated stick shorts (one generated clip per narrated beat) ────────────

/** One ~8s animated beat: the narration, its first frame, and what moves. */
export interface AnimShot {
  /** Spoken narration for this beat (paced to fit one ~8s clip). */
  text: string;
  /** Still that seeds the clip's first frame — pins the character design. */
  imagePrompt: string;
  /** What actually MOVES across the 8 seconds. */
  motionPrompt: string;
}

export interface AnimPlan {
  title: string;
  description: string;
  hashtags: string[];
  /** The locked visual world, threaded into every frame. */
  setting: string;
  /**
   * The CAST SHEET: a fixed appearance line per recurring figure, repeated
   * byte-identically into every shot. This is what makes a character
   * recognisable across independently generated clips — the video model can't
   * use a person's name (it refuses real ones outright), so a stable physical
   * description is the only verbal handle on identity it has.
   */
  cast: string;
  shots: AnimShot[];
}

export interface PlanAnimationInput {
  setting: string;
  /** Art-style preset key, e.g. "stick-scene". */
  style: string;
  beats: Array<{ text: string; imagePrompt: string }>;
}

export interface SuggestTopicsInput {
  category?: string;
  count: number;
  /** Recently-used topics to steer AWAY from, so suggestions don't repeat. */
  avoid?: string[];
}

// ── Cook Studio (generated cook-in-the-wild videos) ──────────────────────────

/** One ~8s shot: a fully-specified video prompt (the style bible baked in). */
export interface CookShot {
  /** The complete video prompt for this shot — every aspect pinned, continuity-threaded. */
  prompt: string;
  /**
   * Prompt for the STILL that becomes this shot's first frame. Generated and
   * reviewed before the (20x pricier) clip, and chained off the previous frame
   * so the scene can't drift between cuts.
   */
  imagePrompt?: string;
}

export interface CookPlan {
  title: string;
  description: string;
  hashtags: string[];
  /** Ordered shots; each is a full prompt fed to the video model, hard-cut every ~8-10s. */
  shots: CookShot[];
}

export interface PlanCookInput {
  /** The dish / recipe, e.g. "trout on a river stone". */
  dish: string;
  /** Ceiling on shots (= clips); the planner uses as many as the recipe needs. */
  maxShots: number;
  /** "9:16" (vertical, default) etc. — pinned into every shot for consistency. */
  aspectRatio?: string;
}

/** One POV beat: the environment to render + the motion + the ambient sound. */
export interface PovShot {
  /** The still world in front of you at the start of the beat (no motion verbs). */
  scene: string;
  /** The ~8s first-person motion (rise, turn, cross to the window, shutters open). */
  motion: string;
  /** Native ambient sound for this beat (no music, no voices). */
  audio: string;
}

/**
 * A "POV: you wake up in <place/time>" short — the trademark first-person format.
 * Informative by design: `place`/`date`/`timeOfDay`/`role` and `facts` become the
 * burned-in text overlays, so the short teaches while it immerses.
 */
export interface PovPlan {
  title: string;
  description: string;
  hashtags: string[];
  /** Overlay hook parts. */
  place: string;
  date: string;
  timeOfDay: string;
  /** Who the viewer is ("a dock worker", "a novice monk") — sets the POV context. */
  role: string;
  /** Ordered beats: wake → rise → cross → the world reveals itself. */
  shots: PovShot[];
  /** Short informative lines shown as overlays across the clips (the teaching part). */
  facts: string[];
}

export interface PlanPovInput {
  /** Place + when, e.g. "Constantinople, 1453" or free text. */
  topic: string;
  /** Ceiling on beats (= clips). POV shorts stay tight (2-4). */
  maxShots: number;
}

/** A still handed to the video model as the clip's first frame. */
export interface VideoSeedImage {
  png: Buffer;
  mimeType?: string;
}

/**
 * Generates real video clips. Google Veo via the Gemini API in production; a
 * mock returns a tiny valid mp4 so the whole pipeline runs keyless.
 *
 * `image` switches it to IMAGE-TO-VIDEO: the still becomes the first frame, so
 * the model animates a scene we already approved instead of imagining one from
 * words. That is the main consistency lever — a still costs cents and can be
 * regenerated freely, a clip costs ~80¢ and can't.
 */
export interface VideoProvider {
  generate(input: {
    prompt: string;
    aspectRatio?: string;
    image?: VideoSeedImage;
    /**
     * ASSET REFERENCES — a different feature from `image`. `image` is the clip's
     * FIRST FRAME (supported on every Veo 3.1 variant, Lite included); these are
     * up to 3 stills the model keeps referring to for the whole clip, which is
     * the stronger character anchor. Veo 3.1 and Fast only — Lite rejects them,
     * and the provider sheds them automatically when it does.
     */
    referenceImages?: Buffer[];
    /** Overrides the default exclusions (which bar human faces — wrong for stick figures). */
    negativePrompt?: string;
  }): Promise<{ video: Buffer; ext: "mp4" }>;
}

// ── Call Studio (fictional prank calls / talk-show rage bait) ────────────────

/**
 * One voice in the call. The planner decides ALL of this from a one-line idea
 * ("rage bait a scammer"), and every field is editable before anything is sent —
 * these are what make two synthetic voices sound like two actual people.
 */
export interface CallCharacter {
  /** Speaker label — used verbatim in the transcript AND as the TTS speaker key. */
  name: string;
  /** Who they are in the scenario ("the scammer", "the woman who called back"). */
  role: string;
  gender: "male" | "female";
  /** Age band; steers the read ("late 40s"). */
  age: string;
  /** Accent + register, spoken to the TTS as performance direction. */
  accent: string;
  /** Gemini prebuilt voice name (see GEMINI_VOICES). */
  voice: string;
  /** Personality in one line. */
  personality: string;
  /** What they WANT out of this call — the engine of the conflict. */
  agenda: string;
  /** Verbal tics, filler, catchphrases — the things that read as human. */
  quirks: string;
}

/**
 * The call BRIEF, not a script. The audio pipeline writes the actual back-and-
 * forth from this at generation time; pinning lines here would make every call
 * sound written. What IS pinned is everything that has to stay consistent:
 * who the people are, how it escalates, and where it stops.
 */
export interface CallPlan {
  title: string;
  description: string;
  hashtags: string[];
  /** The one-line premise — "the abouts". */
  premise: string;
  /** The situation a listener must grasp within ~3 seconds. */
  setup: string;
  characters: CallCharacter[];
  /** Ordered escalation beats — the SHAPE of the call, never the lines. */
  escalation: string[];
  /** The specific infuriating details that drive comments. */
  ragebait: string[];
  /** How it ends — cut on the peak, no neat punchline. */
  ending: string;
  /** Target spoken length in seconds. */
  durationSeconds: number;
  /** Extra performance direction (overlaps, interruptions, phone realism). */
  direction: string;
  /** 2-4 image prompts for the visual; the video is audio-led. */
  imagePrompts: string[];
}

export interface PlanCallInput {
  /** The user's one-line command, e.g. "rage bait a scammer who called me". */
  idea: string;
  /** Ceiling on spoken length (cost + platform cap). */
  maxSeconds: number;
}

export interface CallAudioResult {
  audio: Buffer;
  ext: "wav";
  /** The improvised transcript the audio was rendered from. */
  transcript: string;
  /** Speaker-labelled lines in order, for slide timing + captions. */
  lines: Array<{ speaker: string; text: string }>;
}

export interface CallSpeaker {
  name: string;
  /** Gemini prebuilt voice name. */
  voice: string;
  /** Accent/tone direction for this speaker, given to the TTS in prose. */
  direction: string;
}

/**
 * Turns an approved brief into finished call audio: improvises the dialogue,
 * then performs it as a two-speaker recording. Google (Gemini) in production; a
 * mock returns a short silent wav so the pipeline runs keyless.
 */
export interface CallAudioProvider {
  generate(input: {
    /** The APPROVED director's brief — sent verbatim, nothing re-planned. */
    brief: string;
    speakers: CallSpeaker[];
    targetSeconds: number;
  }): Promise<CallAudioResult>;
}

/**
 * Generates images for the story beats. gpt-image-1 in production; a mock draws
 * a solid card so the pipeline runs keyless.
 */
export interface ImageProvider {
  generate(input: {
    prompt: string;
    size?: string;
    /**
     * Previous frame to edit forward instead of drawing from scratch. Honoured
     * by providers that accept image input (Gemini); ignored by the others, who
     * simply draw the prompt — so callers can always pass it.
     */
    referenceImage?: Buffer;
    /** Image-to-image denoise strength (0..1) when referenceImage is set — 1 fully
     *  remakes, low values keep the frame. Overrides the provider default; ignored
     *  by providers that don't do strength-based img2img. */
    strength?: number;
  }): Promise<{ image: Buffer; ext: "png" }>;
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
/** Word-level timing from a TTS that supports it (ElevenLabs). Seconds. */
export interface TtsWord {
  word: string;
  start: number;
  end: number;
}

export interface TtsResult {
  audio: Buffer;
  /** Container so the caller can write a file ffmpeg will read. */
  ext: "mp3" | "wav";
  /**
   * Exact spoken-word timings when the provider returns them (ElevenLabs
   * with-timestamps). Absent for OpenAI/mock — callers fall back to proportional
   * timing. Tags are excluded; only real spoken words appear.
   */
  words?: TtsWord[];
}

export interface TtsProvider {
  /**
   * True when the provider PERFORMS inline "[tag]"s (ElevenLabs v3 audio tags)
   * instead of reading them aloud. Callers must strip tags before sending text
   * to a provider without this.
   */
  readonly speaksTags?: boolean;
  synthesize(input: {
    text: string;
    voice?: string;
    instructions?: string;
    /** Preceding / following narration text — lets a provider condition this chunk
     *  on its neighbours so consecutive chunks of one long narration match in tone
     *  (ElevenLabs previous_text/next_text). Honoured by providers that support it. */
    previousText?: string;
    nextText?: string;
  }): Promise<TtsResult>;
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
  /**
   * Plan an exhaustive, continuity-locked shot list for a cook-in-the-wild
   * video. Every physical aspect is pinned (setting, heat setup, props, hands,
   * exposure, per-shot food state) so the video model can't invent
   * inconsistencies between cuts — retrying doesn't fix that, the script must.
   */
  planCookShots(input: PlanCookInput): Promise<CookPlan>;
  /**
   * Plan a "POV: you wake up in <place/time>" short — the trademark first-person
   * format. Returns the structured overlay facts (place/date/role + teaching
   * lines) and the ordered wake → reveal beats; the service composes each beat
   * into a stick-figure-POV video prompt. Informative by design.
   */
  planPovShort(input: PlanPovInput): Promise<PovPlan>;
  /**
   * Break a beat's single image prompt into `count` successive MOMENTS of that
   * same beat, so a long sentence isn't one static picture. Returns one array
   * per requested beat, in order; a beat asking for 1 just gets its original
   * prompt back.
   */
  expandImagePrompts(input: ExpandImagePromptsInput): Promise<string[][]>;
  /**
   * Dedicated pass that rewrites the finished beats into one tight, accurate
   * on-topic image prompt each — the "tighter + more consistent images" pass.
   * Part of {@link CheapTextProvider} so it can run on a budget model.
   */
  refineImagePrompts(input: RefineImagePromptsInput): Promise<string[]>;
  /**
   * Turn narrated beats into ANIMATION shots: a first-frame still prompt plus
   * the motion that plays over it. Split in two because the still is what keeps
   * the character design stable across clips, and the motion is what the video
   * model actually has to invent.
   */
  planAnimationShots(input: PlanAnimationInput): Promise<{ cast: string; shots: AnimShot[] }>;
  /**
   * Turn a one-line idea ("rage bait a scammer") into a full call BRIEF —
   * characters with gender/accent/voice/agenda/quirks, escalation beats, the
   * infuriating specifics, the ending. Everything is editable before it's sent;
   * the dialogue itself is improvised later by the audio model, not written here.
   */
  planCall(input: PlanCallInput): Promise<CallPlan>;
}
