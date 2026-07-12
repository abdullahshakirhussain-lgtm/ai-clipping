import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { OverviewDto } from "../contracts/index.js";

/** Pipeline-health snapshot for the Overview page (no revenue/metrics engine). */
export class AnalyticsService {
  constructor(
    private readonly repos: Repositories,
    private readonly dispatcher: Dispatcher,
  ) {}

  async overview(): Promise<OverviewDto> {
    const [clipCountsRaw, videoCounts, queues] = await Promise.all([
      this.repos.clips.countByStatus(),
      this.repos.sourceVideos.countByStatus(),
      this.dispatcher.stats(),
    ]);
    const reviewQueueDepth =
      clipCountsRaw.find((c) => c.status === "READY_FOR_REVIEW")?._count ?? 0;
    return {
      clipCounts: clipCountsRaw.map((c) => ({ status: c.status, count: c._count })),
      videoCounts,
      reviewQueueDepth,
      queues,
    };
  }
}
