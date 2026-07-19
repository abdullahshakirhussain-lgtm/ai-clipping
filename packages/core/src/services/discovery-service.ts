import type { DiscoveredVideoStatus, Repositories } from "@clipfactory/db";
import type { SourceFeedProvider } from "@clipfactory/discovery";
import type { DiscoveredVideoDto, IngestDiscoveredInput } from "../contracts/discovery.js";
import { scoreVelocity } from "../discovery-score.js";
import { NotFoundError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { VideoService } from "./video-service.js";

const HOUR_MS = 3_600_000;

interface DiscoveryConfig {
  maxAgeHours: number;
}

/**
 * Finder: discovers accelerating source-platform videos, ranks them by velocity,
 * and one-click sends chosen ones into the normal URL ingest pipeline.
 */
export class DiscoveryService {
  constructor(
    private readonly repos: Repositories,
    private readonly providers: SourceFeedProvider[],
    private readonly videos: VideoService,
    private readonly logger: Logger,
    private readonly config: DiscoveryConfig,
  ) {}

  /** True when at least one real feed provider is configured. */
  get enabled(): boolean {
    return this.providers.length > 0;
  }

  /**
   * Fetch every provider's trending feed, drop stale/already-ingested items,
   * (re)score velocity, and upsert. Best-effort per provider — one failing feed
   * doesn't sink the poll. Returns how many rows were touched.
   */
  async poll(): Promise<{ upserted: number }> {
    const now = new Date();
    let upserted = 0;
    for (const provider of this.providers) {
      let candidates;
      try {
        candidates = await provider.fetchTrending();
      } catch (err) {
        this.logger.warn({ platform: provider.platform, reason: String(err) }, "discovery poll failed");
        continue;
      }
      const ingested = await this.repos.discovered.ingestedExternalIds(provider.platform);
      for (const c of candidates) {
        const ageHours = (now.getTime() - c.sourceCreatedAt.getTime()) / HOUR_MS;
        if (ageHours > this.config.maxAgeHours) continue; // too old to be "early"
        if (ingested.has(c.externalId)) continue; // already sent to the pipeline
        const existing = await this.repos.discovered.byExternal(c.platform, c.externalId);
        if (existing && existing.status === "HIDDEN") continue; // user dismissed it
        const { velocity } = scoreVelocity({
          scoreNow: c.score,
          sourceCreatedAt: c.sourceCreatedAt,
          firstSeenScore: existing?.firstSeenScore,
          firstSeenAt: existing?.firstSeenAt,
          now,
          maxAgeHours: this.config.maxAgeHours,
        });
        const peakScore = Math.max(existing?.peakScore ?? 0, c.score);
        await this.repos.discovered.upsert(
          {
            platform: c.platform,
            externalId: c.externalId,
            url: c.url,
            permalink: c.permalink,
            title: c.title,
            thumbnailUrl: c.thumbnailUrl ?? null,
            author: c.author ?? null,
            source: c.source,
            mediaType: c.mediaType,
            sourceCreatedAt: c.sourceCreatedAt,
            score: c.score,
            comments: c.comments,
          },
          { velocity, peakScore },
          now,
        );
        upserted++;
      }
    }
    this.logger.info({ upserted, providers: this.providers.length }, "discovery poll complete");
    return { upserted };
  }

  async list(status: DiscoveredVideoStatus = "NEW"): Promise<DiscoveredVideoDto[]> {
    const rows = await this.repos.discovered.list(status);
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      url: r.url,
      permalink: r.permalink,
      title: r.title,
      thumbnailUrl: r.thumbnailUrl,
      author: r.author,
      source: r.source,
      mediaType: r.mediaType,
      sourceCreatedAt: r.sourceCreatedAt.toISOString(),
      score: r.score,
      comments: r.comments,
      velocity: Math.round(r.velocity),
      ageHours: Math.round(((now - r.sourceCreatedAt.getTime()) / HOUR_MS) * 10) / 10,
      status: r.status,
      ingestedVideoId: r.ingestedVideoId,
    }));
  }

  /** Send a discovered candidate into the pipeline and mark it INGESTED. */
  async ingest(id: string, settings: IngestDiscoveredInput): Promise<{ sourceVideoId: string }> {
    const row = await this.repos.discovered.byId(id);
    if (!row) throw new NotFoundError("DiscoveredVideo", id);
    const { sourceVideoId } = await this.videos.ingestUrl({
      url: row.url,
      title: row.title,
      category: settings.category,
      commentaryMode: settings.commentaryMode,
      subtitlesOnly: settings.subtitlesOnly,
      untouched: settings.untouched,
      captionStyle: settings.captionStyle,
      captionPosition: settings.captionPosition,
      reframe: settings.reframe,
      autoEnhance: settings.autoEnhance,
      // Seed context with where it came from — the vision pass refines it.
      context: `From r/${row.source} on ${row.platform}: "${row.title}"`,
    });
    await this.repos.discovered.setStatus(id, "INGESTED", sourceVideoId);
    return { sourceVideoId };
  }

  async hide(id: string): Promise<{ hidden: true }> {
    const row = await this.repos.discovered.byId(id);
    if (!row) throw new NotFoundError("DiscoveredVideo", id);
    await this.repos.discovered.setStatus(id, "HIDDEN");
    return { hidden: true };
  }
}
