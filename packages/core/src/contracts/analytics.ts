import { z } from "zod";
import { ClipStatusSchema, SourceVideoStatusSchema } from "./common.js";

export const QueueStatsSchema = z.array(
  z.object({
    queue: z.string(),
    waiting: z.number(),
    active: z.number(),
    failed: z.number(),
  }),
);

/** Lean pipeline-health snapshot for the Overview page. */
export const OverviewDtoSchema = z.object({
  clipCounts: z.array(z.object({ status: ClipStatusSchema, count: z.number().int() })),
  videoCounts: z.array(z.object({ status: SourceVideoStatusSchema, count: z.number().int() })),
  reviewQueueDepth: z.number().int(),
  queues: QueueStatsSchema,
});
export type OverviewDto = z.infer<typeof OverviewDtoSchema>;
