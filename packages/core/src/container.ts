import { join } from "node:path";
import {
  AnthropicLlmProvider,
  GroqWhisperProvider,
  MockLlmProvider,
  MockTranscriptionProvider,
  type LlmProvider,
  type TranscriptionProvider,
} from "@clipfactory/ai";
import { createRepositories, getPrisma, type Repositories } from "@clipfactory/db";
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
import { CampaignService } from "./services/campaign-service.js";
import { ClipService } from "./services/clip-service.js";
import { PublishService } from "./services/publish-service.js";
import { ReviewService } from "./services/review-service.js";
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
    analytics: AnalyticsService;
  };
  shutdown(): Promise<void>;
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
    if (!env.GROQ_API_KEY || !env.ANTHROPIC_API_KEY) {
      throw new Error("AI_DRIVER=live requires GROQ_API_KEY and ANTHROPIC_API_KEY");
    }
    return {
      transcription: new GroqWhisperProvider({ apiKey: env.GROQ_API_KEY, model: env.GROQ_WHISPER_MODEL }),
      llm: new AnthropicLlmProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL }),
    };
  }
  logger.info("using mock AI providers");
  return {
    transcription: new MockTranscriptionProvider(env.MOCK_VIDEO_DURATION_SEC),
    llm: new MockLlmProvider(),
  };
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
            : new YouTubePublisher();
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
      metricsSyncIntervalMs: 6 * 60 * 60 * 1000,
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

  const services = {
    campaigns: new CampaignService(repos, dispatcher),
    videos: new VideoService(repos, storage, dispatcher),
    clips: new ClipService(repos, storage),
    review: new ReviewService(repos, dispatcher),
    publish: new PublishService(repos, dispatcher),
    accounts: new AccountService(repos),
    analytics: new AnalyticsService(repos, dispatcher),
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
