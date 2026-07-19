import type { FeedCandidate, SourceFeedProvider } from "./types.js";

export interface RedditProviderOptions {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  /** Subreddits to watch (without the "r/"). */
  subreddits: string[];
}

/** Raw shape of the fields we read off a Reddit listing child's `data`. */
export interface RedditPostData {
  id: string;
  name: string; // fullname, e.g. "t3_abc"
  title: string;
  permalink: string;
  url: string;
  author: string;
  subreddit: string;
  created_utc: number;
  ups: number;
  num_comments: number;
  is_video: boolean;
  is_self: boolean;
  over_18: boolean;
  domain: string;
  thumbnail?: string;
  post_hint?: string;
  secure_media?: unknown;
}

const VIDEO_DOMAINS = [
  "v.redd.it",
  "youtube.com",
  "youtu.be",
  "m.youtube.com",
  "streamable.com",
  "redgifs.com",
  "twitch.tv",
  "clips.twitch.tv",
  "kick.com",
];

/**
 * Is this post a clippable video? True for native Reddit video, a `hosted:video`
 * hint, or a link to a known video host. Excludes self/text posts and images.
 * Pure so it can be unit-tested without the network.
 */
export function isVideoPost(p: Pick<RedditPostData, "is_video" | "is_self" | "post_hint" | "domain">): boolean {
  if (p.is_self) return false;
  if (p.is_video) return true;
  if (p.post_hint === "hosted:video" || p.post_hint === "rich:video") return true;
  const domain = (p.domain || "").toLowerCase().replace(/^www\./, "");
  return VIDEO_DOMAINS.includes(domain);
}

/** Map a raw Reddit post to a normalized candidate. */
export function toCandidate(p: RedditPostData): FeedCandidate {
  // Native Reddit videos: hand yt-dlp the post permalink (it resolves the DASH
  // playlist + audio); external links: hand it the direct url.
  const permalink = `https://www.reddit.com${p.permalink}`;
  const url = p.is_video ? permalink : p.url;
  const mediaType = p.is_video
    ? "reddit_video"
    : (p.domain || "").toLowerCase().replace(/^www\.|\.com$|\.tv$|\.it$|\.be$/g, "") || "link";
  const thumb = p.thumbnail && /^https?:\/\//.test(p.thumbnail) ? p.thumbnail : undefined;
  return {
    platform: "reddit",
    externalId: p.name,
    url,
    permalink,
    title: p.title,
    thumbnailUrl: thumb,
    author: p.author,
    source: p.subreddit,
    mediaType,
    sourceCreatedAt: new Date(p.created_utc * 1000),
    score: Math.max(0, Math.round(p.ups ?? 0)),
    comments: Math.max(0, Math.round(p.num_comments ?? 0)),
  };
}

/**
 * Reddit source feed. App-only OAuth (client_credentials), reads each watched
 * subreddit's /rising and /top?t=hour — the velocity feeds — and returns the
 * video posts. NSFW is skipped. Best-effort per subreddit: one failing sub
 * doesn't sink the poll.
 */
export class RedditProvider implements SourceFeedProvider {
  readonly platform = "reddit";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: RedditProviderOptions) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.opts.userAgent,
      },
      body: "grant_type=client_credentials&scope=read",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Reddit auth failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  private async fetchListing(subreddit: string, path: string): Promise<RedditPostData[]> {
    const token = await this.accessToken();
    const res = await fetch(`https://oauth.reddit.com/r/${subreddit}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": this.opts.userAgent },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Reddit listing r/${subreddit}/${path} failed (${res.status}): ${detail.slice(0, 120)}`);
    }
    const json = (await res.json()) as { data?: { children?: Array<{ data: RedditPostData }> } };
    return (json.data?.children ?? []).map((c) => c.data);
  }

  async fetchTrending(): Promise<FeedCandidate[]> {
    const byId = new Map<string, FeedCandidate>();
    for (const sub of this.opts.subreddits) {
      for (const path of ["rising.json?limit=50", "top.json?t=hour&limit=50"]) {
        let posts: RedditPostData[];
        try {
          posts = await this.fetchListing(sub, path);
        } catch {
          continue; // one failing sub/listing shouldn't sink the whole poll
        }
        for (const p of posts) {
          if (p.over_18 || !isVideoPost(p)) continue;
          // rising + top can return the same post — keep the higher-scored copy.
          const cand = toCandidate(p);
          const existing = byId.get(cand.externalId);
          if (!existing || cand.score > existing.score) byId.set(cand.externalId, cand);
        }
      }
    }
    return [...byId.values()];
  }
}
