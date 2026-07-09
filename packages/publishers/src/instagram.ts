import type {
  MetricsSnapshot,
  PublishAccount,
  PublisherAdapter,
  PublishInput,
  PublishResult,
} from "./types.js";
import { PublisherNotConfiguredError } from "./types.js";

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Instagram Reels via the Graph API two-step container flow.
 * Requires a Business/Creator IG account linked to a Facebook Page, an approved
 * Meta app with instagram_content_publish, and credentials { accessToken, igUserId }.
 */
export class InstagramPublisher implements PublisherAdapter {
  readonly platform = "INSTAGRAM" as const;

  private creds(account: PublishAccount): { accessToken: string; igUserId: string } {
    const accessToken = account.credentials?.accessToken;
    const igUserId = account.credentials?.igUserId;
    if (typeof accessToken !== "string" || typeof igUserId !== "string") {
      throw new PublisherNotConfiguredError("INSTAGRAM", "missing credentials.accessToken/igUserId");
    }
    return { accessToken, igUserId };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { accessToken, igUserId } = this.creds(input.account);
    const caption = `${input.title}\n\n${input.description}\n\n${input.hashtags.join(" ")}`.slice(0, 2200);

    // Step 1: create a media container that pulls the video from our URL
    const containerRes = await fetch(`${GRAPH}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url: input.videoUrl,
        caption,
        access_token: accessToken,
      }),
    });
    const container = (await containerRes.json()) as { id?: string; error?: { message?: string } };
    if (!container.id) {
      throw new Error(`Instagram container creation failed: ${container.error?.message}`);
    }

    // Step 2: poll container status, then publish
    for (let i = 0; i < 30; i++) {
      const statusRes = await fetch(
        `${GRAPH}/${container.id}?fields=status_code&access_token=${accessToken}`,
      );
      const status = (await statusRes.json()) as { status_code?: string };
      if (status.status_code === "FINISHED") break;
      if (status.status_code === "ERROR") throw new Error("Instagram media container errored");
      await new Promise((r) => setTimeout(r, 5000));
    }

    const publishRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id, access_token: accessToken }),
    });
    const published = (await publishRes.json()) as { id?: string; error?: { message?: string } };
    if (!published.id) {
      throw new Error(`Instagram publish failed: ${published.error?.message}`);
    }
    return {
      externalPostId: published.id,
      externalUrl: `https://www.instagram.com/reel/${published.id}`,
      raw: { container: container.id, media: published.id },
    };
  }

  async fetchMetrics(externalPostId: string, account: PublishAccount): Promise<MetricsSnapshot> {
    const { accessToken } = this.creds(account);
    const res = await fetch(
      `${GRAPH}/${externalPostId}/insights?metric=plays,likes,comments,shares,ig_reels_avg_watch_time&access_token=${accessToken}`,
    );
    const data = (await res.json()) as {
      data?: Array<{ name: string; values?: Array<{ value?: number }> }>;
    };
    const get = (name: string) =>
      data.data?.find((m) => m.name === name)?.values?.[0]?.value ?? 0;
    return {
      views: get("plays"),
      likes: get("likes"),
      comments: get("comments"),
      shares: get("shares"),
      watchTimeSec: get("ig_reels_avg_watch_time") / 1000,
    };
  }
}
