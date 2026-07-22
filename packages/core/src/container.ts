import { join } from "node:path";
import {
  AnthropicLlmProvider,
  DeepgramTranscriptionProvider,
  ElevenLabsTtsProvider,
  GroqWhisperProvider,
  FalImageProvider,
  MockImageProvider,
  MockLlmProvider,
  MockTranscriptionProvider,
  MockTtsProvider,
  OpenAiImageProvider,
  OpenAiTtsProvider,
  type ImageProvider,
  type LlmProvider,
  type TranscriptionProvider,
  type TtsProvider,
} from "@clipfactory/ai";
import { createRepositories, getPrisma, type Repositories } from "@clipfactory/db";
import { MockFeedProvider, RedditProvider, type SourceFeedProvider } from "@clipfactory/discovery";
import { MockDownloader, YtDlpDownloader, type DownloadProvider } from "@clipfactory/media";
import {
  InstagramPublisher,
  MockPublisher,
  TikTokPublisher,
  YouTubePublisher,
  type PublisherAdapter,
  type PublishPlatform,
} from "@clipfactory/publishers";
import {
  BullMqDispatcher,
  InProcessDispatcher,
  type Dispatcher,
  type HandlerRegistry,
} from "@clipfactory/queue";
import { LocalStorage, R2Storage, type ObjectStorage } from "@clipfactory/storage";
import { loadEnv, type Env } from "./env.js";
import { createLogger, type Logger } from "./logger.js";
import { buildHandlers } from "./pipeline/handlers.js";
import type { PipelineContext } from "./pipeline/context.js";
import { AccountService } from "./services/account-service.js";
import { AnalyticsService } from "./services/analytics-service.js";
import { CalibrationService } from "./services/calibration-service.js";
import { CampaignService } from "./services/campaign-service.js";
import { CategoryService } from "./services/category-service.js";
import { DiscoveryService } from "./services/discovery-service.js";
import { DistributionService } from "./services/distribution-service.js";
import { SystemService } from "./services/system-service.js";
import { ClipService } from "./services/clip-service.js";
import { PublishService } from "./services/publish-service.js";
import { ReviewService } from "./services/review-service.js";
import { StoryService } from "./services/story-service.js";
import { VideoService } from "./services/video-service.js";

export interface Container {
  env: Env;
  logger: Logger;
  repos: Repositories;
  storage: ObjectStorage;
  dispatcher: Dispatcher;
  pipeline: PipelineContext;
  handlers: HandlerRegistry;
  services: {
    campaigns: CampaignService;
    videos: VideoService;
    clips: ClipService;
    review: ReviewService;
    publish: PublishService;
    accounts: AccountService;
    categories: CategoryService;
    analytics: AnalyticsService;
    calibration: CalibrationService;
    distribution: DistributionService;
    discovery: DiscoveryService;
    story: StoryService;
    system: SystemService;
  };
  shutdown(): Promise<void>;
}

/**
 * Finder feed providers. Reddit when credentials are set; otherwise mock so the
 * poll/list flow is runnable in dev, and empty (no poll) when discovery is off.
 */
function buildFeedProviders(env: Env, logger: Logger): SourceFeedProvider[] {
  if (!env.DISCOVERY_ENABLED) return [];
  const subreddits = env.DISCOVERY_SUBREDDITS.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    logger.info({ subreddits: subreddits.length }, "discovery: Reddit provider");
    return [
      new RedditProvider({
        clientId: env.REDDIT_CLIENT_ID,
        clientSecret: env.REDDIT_CLIENT_SECRET,
        userAgent: env.REDDIT_USER_AGENT,
        subreddits,
      }),
    ];
  }
  logger.info("discovery enabled without Reddit creds — using mock feed");
  return [new MockFeedProvider()];
}

function buildStorage(env: Env, logger: Logger): ObjectStorage {
  if (env.STORAGE_DRIVER === "r2") {
    if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID) {
      throw new Error("STORAGE_DRIVER=r2 requires R2_ACCOUNT_ID and R2_ACCESS_KEY_ID");
    }
    return new R2Storage({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL || undefined,
    });
  }
  logger.info({ dir: env.LOCAL_STORAGE_DIR }, "using local storage driver");
  return new LocalStorage({ rootDir: env.LOCAL_STORAGE_DIR, publicBaseUrl: env.API_URL });
}

function buildAiProviders(env: Env, logger: Logger): {
  transcription: TranscriptionProvider;
  llm: LlmProvider;
} {
  if (env.AI_DRIVER === "live") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("AI_DRIVER=live requires ANTHROPIC_API_KEY");

    let transcription: TranscriptionProvider;
    if (env.TRANSCRIBE_PROVIDER === "deepgram") {
      if (!env.DEEPGRAM_API_KEY) {
        throw new Error("TRANSCRIBE_PROVIDER=deepgram requires DEEPGRAM_API_KEY");
      }
      logger.info("using Deepgram transcription (diarized)");
      transcription = new DeepgramTranscriptionProvider({
        apiKey: env.DEEPGRAM_API_KEY,
        model: env.DEEPGRAM_MODEL,
      });
    } else {
      if (!env.GROQ_API_KEY) throw new Error("TRANSCRIBE_PROVIDER=groq requires GROQ_API_KEY");
      transcription = new GroqWhisperProvider({ apiKey: env.GROQ_API_KEY, model: env.GROQ_WHISPER_MODEL });
    }
    return {
      transcription,
      llm: new AnthropicLlmProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
        commentaryModel: env.COMMENTARY_MODEL,
      }),
    };
  }
  logger.info("using mock AI providers");
  return {
    transcription: new MockTranscriptionProvider(env.MOCK_VIDEO_DURATION_SEC),
    llm: new MockLlmProvider(),
  };
}

function buildTtsProvider(env: Env, logger: Logger): TtsProvider {
  if (env.TTS_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("TTS_PROVIDER=openai requires OPENAI_API_KEY");
    logger.info({ model: env.OPENAI_TTS_MODEL, voice: env.OPENAI_TTS_VOICE }, "using OpenAI TTS (steerable)");
    return new OpenAiTtsProvider({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_TTS_MODEL,
      voice: env.OPENAI_TTS_VOICE,
    });
  }
  if (env.TTS_PROVIDER === "elevenlabs") {
    if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
      throw new Error("TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID");
    }
    logger.info({ voice: env.ELEVENLABS_VOICE_ID }, "using ElevenLabs TTS");
    return new ElevenLabsTtsProvider({
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      model: env.ELEVENLABS_MODEL,
    });
  }
  logger.info("using mock TTS (silent commentary)");
  return new MockTtsProvider();
}

/**
 * Per-clip voice tiers. "standard" is whatever TTS_PROVIDER says (the cheap
 * default for every render); "premium" is ElevenLabs v3, chosen clip-by-clip
 * from the Library because it spends paid credits. Premium falls back to
 * standard when ElevenLabs isn't configured, so the button degrades gracefully.
 */
export function makeTtsFor(tiers: { standard: TtsProvider; premium: TtsProvider }): (tier: string) => TtsProvider {
  return (tier) => (tier === "premium" ? tiers.premium : tiers.standard);
}

function buildTtsTiers(env: Env, logger: Logger): (tier: string) => TtsProvider {
  const standard = buildTtsProvider(env, logger);
  let premium: TtsProvider;
  if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) {
    logger.info({ voice: env.ELEVENLABS_VOICE_ID, model: env.ELEVENLABS_MODEL }, "premium voice: ElevenLabs");
    premium = new ElevenLabsTtsProvider({
      apiKey: env.ELEVENLABS_API_KEY,
      voiceId: env.ELEVENLABS_VOICE_ID,
      model: env.ELEVENLABS_MODEL,
    });
  } else {
    logger.info("premium voice not configured — premium tier falls back to standard");
    premium = standard;
  }
  return makeTtsFor({ standard, premium });
}

function buildImageProvider(env: Env, logger: Logger): ImageProvider {
  if (env.IMAGE_PROVIDER === "fal") {
    if (!env.FAL_KEY) throw new Error("IMAGE_PROVIDER=fal requires FAL_KEY");
    logger.info({ model: env.FAL_IMAGE_MODEL }, "using fal.ai image generation (FLUX)");
    return new FalImageProvider({ apiKey: env.FAL_KEY, model: env.FAL_IMAGE_MODEL });
  }
  if (env.IMAGE_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("IMAGE_PROVIDER=openai requires OPENAI_API_KEY");
    logger.info({ model: env.OPENAI_IMAGE_MODEL }, "using OpenAI image generation");
    return new OpenAiImageProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_IMAGE_MODEL });
  }
  logger.info("using mock image provider (solid cards)");
  return new MockImageProvider();
}

function buildDownloader(env: Env): DownloadProvider {
  return env.DOWNLOAD_DRIVER === "ytdlp"
    ? new YtDlpDownloader({
        proxy: env.YTDLP_PROXY || undefined,
        cookiesFile: env.YTDLP_COOKIES_FILE || undefined,
      })
    : new MockDownloader(env.MOCK_VIDEO_DURATION_SEC);
}

function buildPublisherFactory(env: Env): (platform: PublishPlatform) => PublisherAdapter {
  const cache = new Map<PublishPlatform, PublisherAdapter>();
  return (platform) => {
    let adapter = cache.get(platform);
    if (adapter) return adapter;
    if (env.PUBLISH_DRIVER === "mock") {
      adapter = new MockPublisher(platform);
    } else {
      adapter =
        platform === "TIKTOK"
          ? new TikTokPublisher()
          : platform === "INSTAGRAM"
            ? new InstagramPublisher()
            : platform === "YOUTUBE"
              ? new YouTubePublisher()
              : // FACEBOOK has no live auto-poster (extension handles posting).
                new MockPublisher(platform);
    }
    cache.set(platform, adapter);
    return adapter;
  };
}

/**
 * Builds the whole object graph. `withHandlers` controls whether the in-process
 * queue driver registers the pipeline (true for the API dev process and the
 * worker; the BullMQ driver never needs handlers on the producer side).
 */
export function createContainer(opts?: { withHandlers?: boolean }): Container {
  const env = loadEnv();
  const logger = createLogger("clipfactory", process.env.LOG_LEVEL ?? "info");
  const prisma = getPrisma();
  const repos = createRepositories(prisma);
  const storage = buildStorage(env, logger);
  const { transcription, llm } = buildAiProviders(env, logger);
  const ttsFor = buildTtsTiers(env, logger);
  const images = buildImageProvider(env, logger);
  const downloader = buildDownloader(env);
  const publisherFor = buildPublisherFactory(env);

  const workRoot = join(process.cwd(), ".data", "work");

  // Two-phase init: the pipeline context needs a dispatcher, and the in-process
  // dispatcher needs the handlers built from that same context. Resolve the
  // circular reference by filling the dispatcher slot after construction.
  const pipeline = {
    repos,
    storage,
    transcription,
    llm,
    ttsFor,
    images,
    downloader,
    publisherFor,
    logger,
    workRoot,
    config: {
      detection: {
        maxClips: env.DETECT_MAX_CLIPS,
        minScore: env.DETECT_MIN_SCORE,
        minDurationSec: env.DETECT_MIN_DURATION_SEC,
        maxDurationSec: env.DETECT_MAX_DURATION_SEC,
        chunkMinutes: env.DETECT_CHUNK_MIN,
        audioPeaks: env.DETECT_AUDIO_PEAKS,
      },
      // Mock LLM returns "" anyway; the flag mainly saves the frame extraction.
      visionContext: env.VISION_CONTEXT && env.AI_DRIVER === "live",
    },
  } as PipelineContext;

  const handlers = buildHandlers(pipeline);

  let dispatcher: Dispatcher;
  if (env.QUEUE_DRIVER === "bullmq") {
    if (!env.REDIS_URL) throw new Error("QUEUE_DRIVER=bullmq requires REDIS_URL");
    dispatcher = new BullMqDispatcher(env.REDIS_URL);
  } else {
    dispatcher = new InProcessDispatcher({
      registry: opts?.withHandlers === false ? {} : handlers,
      logger,
    });
  }
  pipeline.dispatcher = dispatcher;

  const videos = new VideoService(repos, storage, dispatcher);
  const services = {
    campaigns: new CampaignService(repos, dispatcher),
    videos,
    clips: new ClipService(repos, storage, dispatcher),
    review: new ReviewService(repos, dispatcher),
    publish: new PublishService(repos, dispatcher),
    accounts: new AccountService(repos),
    categories: new CategoryService(),
    analytics: new AnalyticsService(repos, dispatcher),
    calibration: new CalibrationService(repos),
    distribution: new DistributionService(repos, storage),
    discovery: new DiscoveryService(repos, buildFeedProviders(env, logger), videos, logger, {
      maxAgeHours: env.DISCOVERY_MAX_AGE_H,
    }),
    story: new StoryService(repos, llm, dispatcher, env.STORY_MAX_BEATS),
    system: new SystemService(),
  };

  return {
    env,
    logger,
    repos,
    storage,
    dispatcher,
    pipeline,
    handlers,
    services,
    async shutdown() {
      await dispatcher.close();
      await prisma.$disconnect();
    },
  };
}
