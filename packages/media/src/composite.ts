/**
 * Way A of the stickman pipeline: paste the deterministic code-drawn figure onto
 * an AI-generated background. The figure is never touched by an image model, so
 * the character is byte-identical across every frame — the reliable path.
 *
 * sharp is loaded lazily (as elsewhere in this package) so its native binding
 * only initialises when a frame is actually composited.
 */

export interface CompositeOpts {
  /** Figure height as a fraction of the background height. */
  heightFrac?: number;
  /** Horizontal centre of the figure, 0..1. */
  xFrac?: number;
  /** Where the figure's feet sit vertically, 0..1 (1 = bottom edge). */
  bottomFrac?: number;
}

/**
 * Composite a transparent figure PNG (from {@link renderStickman}) onto a
 * background PNG/JPEG buffer and return the flattened PNG. The figure is scaled by
 * height and anchored by its feet so it stands in the scene.
 */
export async function compositeFigure(background: Buffer, figurePng: Buffer, opts: CompositeOpts = {}): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const bg = sharp(background);
  const meta = await bg.metadata();
  const W = meta.width ?? 768;
  const H = meta.height ?? 1280;

  const figH = Math.max(1, Math.round((opts.heightFrac ?? 0.5) * H));
  const fig = await sharp(figurePng).resize({ height: figH }).png().toBuffer();
  const figMeta = await sharp(fig).metadata();
  const figW = figMeta.width ?? figH;

  const left = Math.round((opts.xFrac ?? 0.5) * W - figW / 2);
  const top = Math.round((opts.bottomFrac ?? 0.96) * H - figH);

  return bg
    .composite([{ input: fig, left: Math.max(0, Math.min(left, W - figW)), top: Math.max(0, Math.min(top, H - figH)) }])
    .png()
    .toBuffer();
}

/**
 * The reused like/subscribe/follow OUTRO card: a cheerful flat background with
 * "LIKE · SUBSCRIBE · FOLLOW" text and a happy code-drawn stick figure. Fully
 * deterministic, so it can be built once and cached. Sized to the video frame.
 */
export async function buildOutroCard(width: number, height: number): Promise<Buffer> {
  const { renderStickman } = await import("./stickman.js");
  const { default: sharp } = await import("sharp");
  const big = Math.round(width * 0.12);
  const small = Math.round(width * 0.05);
  const cy = Math.round(height * 0.22);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffd23f"/>` +
    `<g font-family="Arial, sans-serif" font-weight="bold" text-anchor="middle" fill="#141414">` +
    `<text x="${width / 2}" y="${cy}" font-size="${big}">LIKE</text>` +
    `<text x="${width / 2}" y="${cy + big * 1.15}" font-size="${big}">SUBSCRIBE</text>` +
    `<text x="${width / 2}" y="${cy + big * 2.3}" font-size="${big}">FOLLOW</text>` +
    `<text x="${width / 2}" y="${cy + big * 3.2}" font-size="${small}" font-weight="normal">for more stories</text>` +
    `</g></svg>`;

  const { figurePng } = await renderStickman({ figures: [{ pose: "arms-raised", expression: "happy", scale: 0.9 }], width: 300, height: 450 });
  const figH = Math.round(height * 0.4);
  const fig = await sharp(figurePng).resize({ height: figH }).png().toBuffer();
  const figW = (await sharp(fig).metadata()).width ?? figH;
  const left = Math.round(width / 2 - figW / 2);
  const top = Math.round(height * 0.95 - figH);
  return sharp(Buffer.from(svg))
    .composite([{ input: fig, left: Math.max(0, left), top: Math.max(0, top) }])
    .png()
    .toBuffer();
}
