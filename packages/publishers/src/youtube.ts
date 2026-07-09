import { createReadStream, promises as fs } from "node:fs";
import type {
  MetricsSnapshot,
  PublishAccount,
  PublisherAdapter,
  PublishInput,
  PublishResult,
} from "./types.js";
import { PublisherNotConfiguredError } from "./types.js";

/**
 * YouTube Shorts via the YouTube Data API v3 resumable upload.
 * Requires an OAuth2 access token with youtube.upload scope in
 * account.credentials.accessToken. Shorts are regular uploads of vertical
 * video <= 3 minutes; #Shorts in the title/description helps classification.
 */
export class YouTubePublisher implements PublisherAdapter {
  readonly platform = "YOUTUBE" as const;

  private token(account: PublishAccount): string {
    const token = account.credentials?.accessToken;
    if (typeof token !== "string" || !token) {
      throw new PublisherNotConfiguredError("YOUTUBE", "missing credentials.accessToken");
    }
    return token;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = this.token(input.account);
    const { size } = await fs.stat(input.videoFilePath);

    const initRes = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Length": String(size),
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify({
          snippet: {
            title: `${input.title} #Shorts`.slice(0, 100),
            description: `${input.description}\n\n${input.hashtags.join(" ")}`.slice(0, 5000),
            categoryId: "22",
          },
          status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
        }),
      },
    );
    const uploadUrl = initRes.headers.get("location");
    if (!initRes.ok || !uploadUrl) {
      throw new Error(`YouTube upload init failed (${initRes.status}): ${await initRes.text()}`);
    }

    // Node's fetch needs `duplex: "half"` for a stream body; typed as any since
    // the DOM RequestInit lib type does not model it.
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(size), "Content-Type": "video/mp4" },
      body: createReadStream(input.videoFilePath),
      duplex: "half",
    } as any);
    const video = (await uploadRes.json()) as { id?: string; error?: { message?: string } };
    if (!video.id) {
      throw new Error(`YouTube upload failed: ${video.error?.message}`);
    }
    return {
      externalPostId: video.id,
      externalUrl: `https://www.youtube.com/shorts/${video.id}`,
      raw: video as Record<string, unknown>,
    };
  }

  async fetchMetrics(externalPostId: string, account: PublishAccount): Promise<MetricsSnapshot> {
    const token = this.token(account);
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${externalPostId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as {
      items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }>;
    };
    const stats = data.items?.[0]?.statistics;
    return {
      views: Number(stats?.viewCount ?? 0),
      likes: Number(stats?.likeCount ?? 0),
      comments: Number(stats?.commentCount ?? 0),
      shares: 0, // not exposed by the Data API
      watchTimeSec: 0, // requires YouTube Analytics API
    };
  }
}
