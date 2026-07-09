export type PublishPlatform = "TIKTOK" | "INSTAGRAM" | "YOUTUBE";

export interface PublishAccount {
  id: string;
  platform: PublishPlatform;
  handle: string;
  /** Decrypted platform credentials (access tokens etc.). */
  credentials: Record<string, unknown> | null;
}

export interface PublishInput {
  account: PublishAccount;
  /** Local path of the rendered clip file. */
  videoFilePath: string;
  /** Public/presigned URL of the clip (some platforms pull instead of push). */
  videoUrl: string;
  title: string;
  description: string;
  hashtags: string[];
}

export interface PublishResult {
  externalPostId: string;
  externalUrl: string;
  raw: Record<string, unknown>;
}

export interface MetricsSnapshot {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  watchTimeSec: number;
}

export interface PublisherAdapter {
  readonly platform: PublishPlatform;
  publish(input: PublishInput): Promise<PublishResult>;
  fetchMetrics(externalPostId: string, account: PublishAccount): Promise<MetricsSnapshot>;
}

/** Thrown when an adapter is invoked without the required platform credentials. */
export class PublisherNotConfiguredError extends Error {
  constructor(platform: PublishPlatform, detail: string) {
    super(
      `${platform} publisher is not configured: ${detail}. ` +
        `Platform publishing requires an approved developer app — see docs/ARCHITECTURE.md.`,
    );
    this.name = "PublisherNotConfiguredError";
  }
}
