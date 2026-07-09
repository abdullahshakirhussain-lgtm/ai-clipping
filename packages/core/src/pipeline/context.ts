import type { LlmProvider, TranscriptionProvider } from "@clipfactory/ai";
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
  downloader: DownloadProvider;
  publisherFor: (platform: PublishPlatform) => PublisherAdapter;
  logger: Logger;
  /** Root dir for scratch files during rendering. */
  workRoot: string;
  config: {
    maxCandidatesPerVideo: number;
    /** How often analytics.sync re-polls a published post, ms. */
    metricsSyncIntervalMs: number;
  };
}
