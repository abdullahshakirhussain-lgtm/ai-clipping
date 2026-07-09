import { randomUUID } from "node:crypto";
import type {
  MetricsSnapshot,
  PublishAccount,
  PublisherAdapter,
  PublishInput,
  PublishPlatform,
  PublishResult,
} from "./types.js";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Mock publisher: succeeds instantly and later reports metrics that grow with
 * time since publish (deterministic per post id), so the analytics loop can be
 * exercised end-to-end offline.
 */
export class MockPublisher implements PublisherAdapter {
  constructor(readonly platform: PublishPlatform) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const externalPostId = `mock-${this.platform.toLowerCase()}-${randomUUID().slice(0, 8)}`;
    return {
      externalPostId,
      externalUrl: `https://mock.${this.platform.toLowerCase()}.example/p/${externalPostId}`,
      raw: {
        driver: "mock",
        publishedAt: new Date().toISOString(),
        title: input.title,
        account: input.account.handle,
      },
    };
  }

  async fetchMetrics(externalPostId: string, _account: PublishAccount): Promise<MetricsSnapshot> {
    const seed = hash(externalPostId);
    // Growth curve: metrics scale with minutes elapsed since a seed-derived epoch
    const minutes = Math.max(1, (Date.now() / 60000) % 100000);
    const base = 200 + (seed % 900);
    const views = Math.round(base * Math.sqrt(minutes % 5000) * (1 + (seed % 7) / 10));
    return {
      views,
      likes: Math.round(views * (0.05 + (seed % 5) / 100)),
      comments: Math.round(views * 0.012),
      shares: Math.round(views * 0.02),
      watchTimeSec: Math.round(views * (15 + (seed % 20))),
    };
  }
}
