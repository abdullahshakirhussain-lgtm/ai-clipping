import type {
  MetricsSnapshot,
  PublishAccount,
  PublisherAdapter,
  PublishInput,
  PublishResult,
} from "./types.js";
import { PublisherNotConfiguredError } from "./types.js";

/**
 * TikTok Content Posting API (PULL_FROM_URL flow).
 * Requires an approved TikTok developer app with the video.publish scope and a
 * user access token stored in account.credentials.accessToken.
 * Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 */
export class TikTokPublisher implements PublisherAdapter {
  readonly platform = "TIKTOK" as const;

  private token(account: PublishAccount): string {
    const token = account.credentials?.accessToken;
    if (typeof token !== "string" || !token) {
      throw new PublisherNotConfiguredError("TIKTOK", "missing credentials.accessToken");
    }
    return token;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const token = this.token(input.account);
    const caption = `${input.title}\n\n${input.hashtags.join(" ")}`.slice(0, 2200);

    const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        post_info: {
          title: caption,
          privacy_level: "SELF_ONLY", // switch to PUBLIC_TO_EVERYONE after app audit
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: "PULL_FROM_URL",
          video_url: input.videoUrl,
        },
      }),
    });
    const data = (await initRes.json()) as {
      data?: { publish_id?: string };
      error?: { code?: string; message?: string };
    };
    if (!initRes.ok || !data.data?.publish_id) {
      throw new Error(`TikTok publish init failed: ${data.error?.message ?? initRes.status}`);
    }
    return {
      externalPostId: data.data.publish_id,
      externalUrl: `https://www.tiktok.com/@${input.account.handle.replace(/^@/, "")}`,
      raw: data as Record<string, unknown>,
    };
  }

  async fetchMetrics(externalPostId: string, account: PublishAccount): Promise<MetricsSnapshot> {
    const token = this.token(account);
    const res = await fetch(
      "https://open.tiktokapis.com/v2/video/query/?fields=like_count,comment_count,share_count,view_count",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ filters: { video_ids: [externalPostId] } }),
      },
    );
    const data = (await res.json()) as {
      data?: { videos?: Array<{ view_count?: number; like_count?: number; comment_count?: number; share_count?: number }> };
    };
    const v = data.data?.videos?.[0];
    return {
      views: v?.view_count ?? 0,
      likes: v?.like_count ?? 0,
      comments: v?.comment_count ?? 0,
      shares: v?.share_count ?? 0,
      watchTimeSec: 0, // not exposed by the public API
    };
  }
}
