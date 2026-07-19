/**
 * Velocity scoring for Finder candidates. The rank key answers "how fast is this
 * accelerating while it's still young?" — not raw popularity. Transparent like
 * the clip scorer: the breakdown explains every number.
 */
export interface VelocityInput {
  /** Current metric (upvotes / views). */
  scoreNow: number;
  /** When the post was created on the source platform. */
  sourceCreatedAt: Date;
  /** Metric at the first poll we saw it (absent on first sight). */
  firstSeenScore?: number;
  /** When we first saw it (absent on first sight). */
  firstSeenAt?: Date;
  /** Injectable clock for tests. */
  now?: Date;
  /** Candidates older than this many hours are decayed toward zero. */
  maxAgeHours?: number;
}

export interface VelocityResult {
  velocity: number;
  breakdown: {
    ageHours: number;
    ageRate: number; // scoreNow / ageHours
    deltaRate: number | null; // (scoreNow - firstSeenScore) / hoursSinceFirstSeen
    recencyFactor: number; // 1 while young, decays past maxAgeHours
  };
}

const HOUR_MS = 3_600_000;

/**
 * Blend two rates:
 *  - ageRate: scoreNow / ageHours — usable on first sight, a decent instantaneous
 *    velocity (a 30-min-old post at 4k upvotes is moving faster than a 10h-old at 9k).
 *  - deltaRate: growth measured between our own polls, once we have a prior sample.
 * Take the max (whichever evidence says "hotter"), then decay by recency so a still-
 * fast but aging post ranks below a fresh climber.
 */
export function scoreVelocity(input: VelocityInput): VelocityResult {
  const now = input.now ?? new Date();
  const maxAgeHours = input.maxAgeHours ?? 24;
  const ageHours = Math.max(0.05, (now.getTime() - input.sourceCreatedAt.getTime()) / HOUR_MS);
  const scoreNow = Math.max(0, input.scoreNow);

  const ageRate = scoreNow / ageHours;

  let deltaRate: number | null = null;
  if (input.firstSeenAt && input.firstSeenScore !== undefined) {
    const dtHours = (now.getTime() - input.firstSeenAt.getTime()) / HOUR_MS;
    if (dtHours >= 0.05) {
      deltaRate = Math.max(0, (scoreNow - input.firstSeenScore) / dtHours);
    }
  }

  const rawRate = deltaRate === null ? ageRate : Math.max(ageRate, deltaRate);

  // Recency: full weight while young, linearly toward 0.1 as it approaches maxAge,
  // then a hard floor so stale posts sink but never go negative.
  const recencyFactor =
    ageHours <= maxAgeHours ? Math.max(0.1, 1 - (ageHours / maxAgeHours) * 0.9) : 0.05;

  return {
    velocity: rawRate * recencyFactor,
    breakdown: {
      ageHours: Number(ageHours.toFixed(2)),
      ageRate: Number(ageRate.toFixed(1)),
      deltaRate: deltaRate === null ? null : Number(deltaRate.toFixed(1)),
      recencyFactor: Number(recencyFactor.toFixed(3)),
    },
  };
}
