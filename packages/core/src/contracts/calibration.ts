import { z } from "zod";

export const CalibrationDtoSchema = z.object({
  /** Number of outcome-labeled clips the weights were computed from. */
  sampleSize: z.number().int(),
  /** True once enough labels existed to actually override the defaults. */
  applied: z.boolean(),
  /** Per-signal correlation with real outcomes, best predictor first. */
  insights: z.array(z.object({ signal: z.string(), correlation: z.number() })),
  /** Current (possibly learned) scoring weights. */
  weights: z.record(z.unknown()).nullable(),
  updatedAt: z.string().nullable(),
});
export type CalibrationDto = z.infer<typeof CalibrationDtoSchema>;
