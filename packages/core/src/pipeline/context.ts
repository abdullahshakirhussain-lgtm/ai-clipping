import type {
  CallAudioProvider,
  CheapTextProvider,
  ImageProvider,
  LlmProvider,
  TranscriptionProvider,
  TtsProvider,
  VideoProvider,
} from "@clipfactory/ai";
import type { Repositories } from "@clipfactory/db";
import type { DownloadProvider } from "@clipfactory/media";
import type { PublisherAdapter, PublishPlatform } from "@clipfactory/publishers";
import type { Dispatcher } from "@clipfactory/queue";
import type { ObjectStorage } from "@clipfactory/storage";
import type { Logger } from "../logger.js";

/**
 * Everything the pipeline stages need, wired once in the container. Passing this
 * bundle (rather than reaching for globals) keeps stages pure and testable.
 */
export interface PipelineContext {
  repos: Repositories;
  storage: ObjectStorage;
  dispatcher: Dispatcher;
  transcription: TranscriptionProvider;
  llm: LlmProvider;
  /**
   * Cheap text tasks (topic suggestions + the tight image-prompt pass) — DeepSeek
   * V4 Flash when configured, else falls back to `llm`. The narration writer stays
   * on `llm` (Opus); only these mechanical tasks run cheap.
   */
  cheapText: CheapTextProvider;
  /**
   * Voice for the commentary track by clip tier: "premium" → ElevenLabs v3
   * when configured (manual per-clip upgrade, paid credits), anything else →
   * the standard mock/OpenAI provider.
   */
  ttsFor: (tier: string) => TtsProvider;
  /** Image generation for Story Studio slideshows (stick-figure art). */
  images: ImageProvider;
  /**
   * Image generation for the HERO channel: a trained fal character LoRA that
   * renders the same named human every time. null when HERO_LORA_URL is unset,
   * in which case the "hero-painterly" style falls back to `images`.
   */
  heroImages: ImageProvider | null;
  /**
   * Photoreal stills used as the FIRST FRAME of each generated video clip.
   * null when disabled, in which case the video model works from text alone.
   */
  sceneImages: ImageProvider | null;
  /** Real video generation (Veo Fast) for Cook Studio clips — photoreal, pricier. */
  video: VideoProvider;
  /**
   * Video generation for animated stick shorts. A separate provider because it
   * runs on the CHEAP tier (Veo 3.1 Lite, half the price): flat stick art asks
   * far less of the model than photoreal cooking does.
   */
  animVideo: VideoProvider;
  /** Two-speaker call audio (Gemini) for Call Studio. */
  callAudio: CallAudioProvider;
  downloader: DownloadProvider;
  publisherFor: (platform: PublishPlatform) => PublisherAdapter;
  logger: Logger;
  /** Root dir for scratch files during rendering. */
  workRoot: string;
  config: {
    /** Clip detection + scoring knobs (env-driven; see env.ts DETECT_*). */
    detection: DetectionConfig;
    /** Derive who/what a video is about from sampled frames' on-screen text. */
    visionContext: boolean;
    /** Slideshow knobs. `kenBurns` adds a slow per-slide push-in (STORY_KEN_BURNS). */
    story: { imageSeconds: number; maxImages: number; kenBurns: boolean };
    /** Hero channel: the named protagonist for the prompt + narration. undefined
     *  when the channel isn't configured (HERO_NAME/HERO_TRIGGER empty). */
    hero?: { name: string; desc: string; trigger: string };
    /** FPV ("anime-fpv") channel: optional locked description of the viewer's own
     *  visible body (hands/clothes), prepended to every prompt. "" = use the style's
     *  generic default. */
    animeLook: string;
    /** Parallel Veo calls for animation — the first dial to turn down on 429s. */
    animConcurrency: number;
    /** Lost Chronicles: how long the 8s Veo clip is stretched to, and how. */
    lost: { targetSeconds: number; lengthMode: "slow" | "loop" };
  };
}

export interface DetectionConfig {
  /** Hard ceiling on clips kept per source video after scoring/ranking. */
  maxClips: number;
  /** Overall-score floor (0-100): candidates below this are discarded. */
  minScore: number;
  /** Shortest allowed clip, seconds. */
  minDurationSec: number;
  /** Longest allowed clip, seconds. */
  maxDurationSec: number;
  /** Transcript chunk size for the LLM pass, minutes. */
  chunkMinutes: number;
  /** Whether to run the audio-energy peak detector alongside transcript hooks. */
  audioPeaks: boolean;
}
