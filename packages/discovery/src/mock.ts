import type { FeedCandidate, SourceFeedProvider } from "./types.js";

/**
 * Offline stub so the poll/list/ingest flow runs without Reddit credentials.
 * Returns a couple of deterministic candidates at different ages/scores so the
 * velocity ranking has something to sort.
 */
export class MockFeedProvider implements SourceFeedProvider {
  readonly platform = "mock";

  async fetchTrending(): Promise<FeedCandidate[]> {
    const now = Date.now();
    return [
      {
        platform: "mock",
        externalId: "t3_mock_hot",
        url: "https://www.reddit.com/r/mock/comments/hot/",
        permalink: "https://www.reddit.com/r/mock/comments/hot/",
        title: "Young post climbing fast",
        thumbnailUrl: undefined,
        author: "mock_user",
        source: "mock",
        mediaType: "reddit_video",
        sourceCreatedAt: new Date(now - 30 * 60 * 1000), // 30 min old
        score: 4200,
        comments: 310,
      },
      {
        platform: "mock",
        externalId: "t3_mock_old",
        url: "https://www.reddit.com/r/mock/comments/old/",
        permalink: "https://www.reddit.com/r/mock/comments/old/",
        title: "Older post, higher absolute score",
        thumbnailUrl: undefined,
        author: "mock_user2",
        source: "mock",
        mediaType: "reddit_video",
        sourceCreatedAt: new Date(now - 10 * 60 * 60 * 1000), // 10 h old
        score: 9000,
        comments: 800,
      },
    ];
  }
}
