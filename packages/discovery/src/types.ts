/** A video the Finder discovered on a source platform, before scoring/storage. */
export interface FeedCandidate {
  platform: string;
  /** Stable per-platform id (e.g. Reddit "t3_abc"). Dedupes across polls. */
  externalId: string;
  /** URL handed to yt-dlp on ingest (direct video or the post permalink). */
  url: string;
  permalink: string;
  title: string;
  thumbnailUrl?: string;
  author?: string;
  /** Origin bucket — subreddit name (later: game/streamer). */
  source: string;
  /** "reddit_video" | "youtube" | "streamable" | ... */
  mediaType: string;
  sourceCreatedAt: Date;
  /** Upvotes / views — the metric velocity is measured on. */
  score: number;
  comments: number;
}

/** A source of trending candidates (Reddit now; Twitch/Kick later). */
export interface SourceFeedProvider {
  readonly platform: string;
  /** Pull the current rising/top candidates across the configured sources. */
  fetchTrending(): Promise<FeedCandidate[]>;
}
