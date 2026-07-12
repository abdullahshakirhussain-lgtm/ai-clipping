/**
 * WAVE 3 SCAFFOLD — subject-aware reframing seam.
 *
 * A ReframeProvider inspects the source window and returns a crop-center path
 * over time (normalized 0..1). renderClip can then drive a dynamic crop that
 * keeps the speaker/subject in frame instead of a fixed center crop. The default
 * (`CenterReframeProvider`) returns an empty path → current center-crop behavior.
 * The cloud provider (face / active-speaker tracking via a vision API) is
 * intentionally unimplemented until the API is chosen and REFRAME_API_KEY set.
 */

/** A crop-center keyframe: at time `t` (clip-relative seconds), center at (cx, cy) in 0..1. */
export interface CropKeyframe {
  t: number;
  cx: number;
  cy: number;
}

export interface ReframeRequest {
  inputPath: string;
  startSec: number;
  endSec: number;
}

export interface ReframeProvider {
  /** Return a crop-center path, or [] to fall back to a static center crop. */
  planCropPath(req: ReframeRequest): Promise<CropKeyframe[]>;
}

/** Default: no tracking — renderClip uses its static 9:16 center crop. */
export class CenterReframeProvider implements ReframeProvider {
  async planCropPath(): Promise<CropKeyframe[]> {
    return [];
  }
}

export class ReframeNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReframeNotConfiguredError";
  }
}

/**
 * Cloud face/active-speaker reframing. Skeleton only: sample frames → vision API
 * → build a smoothed crop path. Throws until implemented against the chosen
 * provider so misconfiguration fails loudly rather than silently mis-cropping.
 */
export class CloudReframeProvider implements ReframeProvider {
  constructor(private readonly opts: { apiKey: string }) {}

  async planCropPath(_req: ReframeRequest): Promise<CropKeyframe[]> {
    void this.opts;
    throw new ReframeNotConfiguredError(
      "Cloud reframing is scaffolded but not implemented yet — pick a vision API and wire planCropPath().",
    );
  }
}
