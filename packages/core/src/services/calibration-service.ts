import type { Repositories } from "@clipfactory/db";
import type { CalibrationDto } from "../contracts/index.js";
import {
  computeCalibration,
  SCORING_WEIGHTS,
  type ClipOutcomeLabel,
  type LabeledClip,
  type StoredSignals,
} from "../detection.js";

/** Turn a stored clip row into a labeled sample, or null if it lacks signals. */
function toLabeled(row: { scoreBreakdown: unknown; outcome: string | null }): LabeledClip | null {
  const sb = row.scoreBreakdown as { signals?: StoredSignals } | null;
  if (!sb?.signals || !row.outcome) return null;
  return { signals: sb.signals, outcome: row.outcome as ClipOutcomeLabel };
}

/**
 * The learning loop: reads outcome-labeled clips, measures which sub-signals
 * actually predicted results, and (with enough data) rewrites the scoring
 * weights so future detection favors what works for THIS user's content.
 */
export class CalibrationService {
  constructor(private readonly repos: Repositories) {}

  /** Current state — stored learned weights if present, else a live preview. */
  async get(): Promise<CalibrationDto> {
    const [row, labeledRows] = await Promise.all([
      this.repos.calibration.get(),
      this.repos.clips.labeledForCalibration(),
    ]);
    const labeled = labeledRows.map(toLabeled).filter((l): l is LabeledClip => l !== null);
    const preview = computeCalibration(labeled);
    return {
      sampleSize: preview.sampleSize,
      applied: Boolean(row),
      insights: preview.insights,
      weights: (row?.weights as Record<string, unknown> | undefined) ??
        (preview.applied ? preview.weights : SCORING_WEIGHTS) as unknown as Record<string, unknown>,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** Recompute + persist learned weights from the latest labels. */
  async recompute(): Promise<CalibrationDto> {
    const labeledRows = await this.repos.clips.labeledForCalibration();
    const labeled = labeledRows.map(toLabeled).filter((l): l is LabeledClip => l !== null);
    const result = computeCalibration(labeled);
    if (result.applied) {
      await this.repos.calibration.upsert({
        weights: result.weights as never,
        sampleSize: result.sampleSize,
        insights: result.insights as never,
      });
    }
    return {
      sampleSize: result.sampleSize,
      applied: result.applied,
      insights: result.insights,
      weights: result.weights as unknown as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    };
  }
}
