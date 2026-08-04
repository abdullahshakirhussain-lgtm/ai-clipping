/**
 * Deterministic stick-figure renderer — the shared foundation of the stickman
 * pipeline. The figure is drawn by CODE (SVG lines + a circle head + a dot face),
 * never by an image model, so the character is byte-identical every frame. This
 * is the whole point: a diffusion model is worst at drawing a simple, exact,
 * repeatable stick figure, so we take the figure away from it and let AI draw
 * only the (open-ended) world around it.
 *
 * Each render yields TWO rasters from the same geometry:
 *  - `figurePng`  — a transparent, coloured cut-out to composite onto an
 *                   AI-drawn background (Way A: the figure holds nothing).
 *  - `controlPng` — a clean black-line-on-white skeleton to hand a ControlNet as
 *                   an unbreakable stencil (Way B: the figure holds/touches an
 *                   object, which the AI draws into the posed hand).
 *
 * sharp (already a dependency, see reframe.ts) rasterises the SVG. It is loaded
 * lazily so the native binding only initialises when a figure is actually drawn.
 */

export type PoseName =
  | "stand"
  | "walk"
  | "run"
  | "point"
  | "hold-out"
  | "two-hands-front"
  | "overhead-swing"
  | "carry-side"
  | "kneel"
  | "sit"
  | "sit-cross-legged"
  | "arms-raised"
  | "bow"
  | "ride";

export type Expression = "neutral" | "happy" | "scared" | "sad" | "angry" | "surprised";
export type HeadItem = "none" | "crown" | "hat" | "helmet";

/** One figure in a shot. `x` is the horizontal centre (0..1); `scale` is the
 *  figure's height as a fraction of the canvas height; `flip` faces it left. */
export interface FigureSpec {
  pose: PoseName;
  expression?: Expression;
  headItem?: HeadItem;
  x?: number; // 0..1 horizontal centre, default 0.5
  scale?: number; // 0..1 of canvas height, default 0.62
  flip?: boolean; // face left instead of right
}

export interface RenderStickmanInput {
  figures: FigureSpec[];
  width: number;
  height: number;
}

type Pt = readonly [number, number];

/** Full joint set in a local 100×150 box (ground at y≈150). Elbows/knees give
 *  the limbs a bend so seated/kneeling/running poses actually read. */
interface Joints {
  head: Pt;
  headR: number;
  shoulder: Pt;
  hip: Pt;
  elbowL: Pt;
  elbowR: Pt;
  handL: Pt;
  handR: Pt;
  kneeL: Pt;
  kneeR: Pt;
  footL: Pt;
  footR: Pt;
}

// Poses authored by hand in the 100×150 box. Right = the figure's action side
// (the hand an object is drawn into for Way B). Start with a solid core set;
// add more poses on demand (they are pure data).
const POSES: Record<PoseName, Joints> = {
  stand: { head: [50, 20], headR: 13, shoulder: [50, 36], hip: [50, 92], elbowL: [40, 58], elbowR: [60, 58], handL: [38, 78], handR: [62, 78], kneeL: [44, 118], kneeR: [56, 118], footL: [42, 148], footR: [58, 148] },
  walk: { head: [50, 20], headR: 13, shoulder: [50, 36], hip: [50, 92], elbowL: [42, 56], elbowR: [60, 58], handL: [40, 74], handR: [64, 72], kneeL: [38, 116], kneeR: [58, 116], footL: [32, 148], footR: [66, 146] },
  run: { head: [56, 20], headR: 13, shoulder: [54, 36], hip: [46, 92], elbowL: [40, 64], elbowR: [66, 50], handL: [30, 74], handR: [74, 44], kneeL: [38, 120], kneeR: [58, 112], footL: [28, 150], footR: [70, 140] },
  point: { head: [50, 20], headR: 13, shoulder: [50, 36], hip: [50, 92], elbowL: [42, 56], elbowR: [64, 44], handL: [40, 76], handR: [84, 34], kneeL: [44, 118], kneeR: [56, 118], footL: [42, 148], footR: [58, 148] },
  "hold-out": { head: [50, 20], headR: 13, shoulder: [50, 36], hip: [50, 92], elbowL: [42, 56], elbowR: [64, 60], handL: [40, 76], handR: [88, 62], kneeL: [44, 118], kneeR: [56, 118], footL: [42, 148], footR: [58, 148] },
  "two-hands-front": { head: [50, 20], headR: 13, shoulder: [50, 36], hip: [50, 92], elbowL: [56, 54], elbowR: [62, 58], handL: [80, 68], handR: [86, 74], kneeL: [44, 118], kneeR: [56, 118], footL: [42, 148], footR: [58, 148] },
  "overhead-swing": { head: [50, 22], headR: 13, shoulder: [50, 38], hip: [50, 92], elbowL: [44, 22], elbowR: [58, 20], handL: [44, 6], handR: [60, 4], kneeL: [42, 118], kneeR: [60, 118], footL: [38, 148], footR: [64, 148] },
  "carry-side": { head: [50, 20], headR: 13, shoulder: [50, 36], hip: [50, 92], elbowL: [40, 58], elbowR: [60, 58], handL: [38, 90], handR: [64, 90], kneeL: [44, 118], kneeR: [56, 118], footL: [42, 148], footR: [58, 148] },
  kneel: { head: [50, 30], headR: 13, shoulder: [50, 46], hip: [50, 100], elbowL: [42, 66], elbowR: [62, 66], handL: [40, 88], handR: [66, 90], kneeL: [42, 146], kneeR: [64, 126], footL: [36, 150], footR: [70, 150] },
  sit: { head: [50, 34], headR: 13, shoulder: [50, 50], hip: [50, 104], elbowL: [42, 68], elbowR: [60, 68], handL: [40, 92], handR: [62, 92], kneeL: [72, 108], kneeR: [82, 106], footL: [74, 148], footR: [84, 148] },
  "sit-cross-legged": { head: [50, 46], headR: 13, shoulder: [50, 62], hip: [50, 116], elbowL: [40, 82], elbowR: [60, 82], handL: [38, 108], handR: [62, 108], kneeL: [32, 130], kneeR: [68, 130], footL: [60, 138], footR: [40, 138] },
  "arms-raised": { head: [50, 22], headR: 13, shoulder: [50, 38], hip: [50, 92], elbowL: [38, 46], elbowR: [62, 46], handL: [30, 26], handR: [70, 26], kneeL: [44, 118], kneeR: [56, 118], footL: [42, 148], footR: [58, 148] },
  bow: { head: [38, 44], headR: 13, shoulder: [44, 54], hip: [50, 92], elbowL: [38, 68], elbowR: [50, 68], handL: [34, 86], handR: [46, 86], kneeL: [46, 118], kneeR: [58, 118], footL: [44, 148], footR: [58, 148] },
  ride: { head: [50, 32], headR: 13, shoulder: [50, 46], hip: [50, 96], elbowL: [42, 62], elbowR: [62, 62], handL: [40, 84], handR: [70, 82], kneeL: [32, 120], kneeR: [68, 120], footL: [30, 146], footR: [70, 146] },
};

interface Palette {
  stroke: string;
  strokeW: number;
  headFill: string;
  crown: string;
  helmet: string;
  hat: string;
}

const COLOR: Palette = { stroke: "#141414", strokeW: 4, headFill: "#f3e7cf", crown: "#e8b923", helmet: "#9aa3ab", hat: "#ffffff" };
const LINE: Palette = { stroke: "#000000", strokeW: 4, headFill: "#ffffff", crown: "#ffffff", helmet: "#ffffff", hat: "#ffffff" };

const line = (a: Pt, b: Pt, p: Palette) =>
  `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${p.stroke}" stroke-width="${p.strokeW}" stroke-linecap="round"/>`;

/** Eyes + mouth (+ brows) inside the head, keyed to expression. */
function face(head: Pt, r: number, expr: Expression, p: Palette): string {
  const [cx, cy] = head;
  const ex = r * 0.4; // eye offset
  const ey = cy - r * 0.15;
  const big = expr === "surprised";
  const eyeR = big ? 2.4 : 1.7;
  const eyes = `<circle cx="${cx - ex}" cy="${ey}" r="${eyeR}" fill="${p.stroke}"/><circle cx="${cx + ex}" cy="${ey}" r="${eyeR}" fill="${p.stroke}"/>`;
  const my = cy + r * 0.42;
  const sw = p.strokeW * 0.8;
  const stroke = `stroke="${p.stroke}" stroke-width="${sw}" fill="none" stroke-linecap="round"`;
  let mouth: string;
  switch (expr) {
    case "happy": mouth = `<path d="M ${cx - 5} ${my - 1} Q ${cx} ${my + 4} ${cx + 5} ${my - 1}" ${stroke}/>`; break;
    case "sad": mouth = `<path d="M ${cx - 5} ${my + 2} Q ${cx} ${my - 3} ${cx + 5} ${my + 2}" ${stroke}/>`; break;
    case "angry": mouth = `<path d="M ${cx - 5} ${my + 1} L ${cx + 5} ${my + 1}" ${stroke}/>`; break;
    case "scared": mouth = `<ellipse cx="${cx}" cy="${my + 1}" rx="2.6" ry="3.4" fill="${p.stroke}"/>`; break;
    case "surprised": mouth = `<circle cx="${cx}" cy="${my + 1}" r="2.8" fill="${p.stroke}"/>`; break;
    default: mouth = `<path d="M ${cx - 4} ${my} L ${cx + 4} ${my}" ${stroke}/>`;
  }
  // Brows add emotion where a mouth alone is ambiguous.
  let brows = "";
  const bx = ex + 1;
  const by = cy - r * 0.5;
  if (expr === "angry") brows = `<path d="M ${cx - bx - 2} ${by - 1} L ${cx - bx + 3} ${by + 2}" ${stroke}/><path d="M ${cx + bx + 2} ${by - 1} L ${cx + bx - 3} ${by + 2}" ${stroke}/>`;
  else if (expr === "scared" || expr === "surprised") brows = `<path d="M ${cx - bx - 2} ${by} L ${cx - bx + 2} ${by - 2}" ${stroke}/><path d="M ${cx + bx + 2} ${by} L ${cx + bx - 2} ${by - 2}" ${stroke}/>`;
  return eyes + mouth + brows;
}

/** A head accessory (the ONLY authored clothing) or a small hair tuft. */
function headwear(head: Pt, r: number, item: HeadItem, p: Palette): string {
  const [cx, cy] = head;
  const top = cy - r;
  const sw = `stroke="${p.stroke}" stroke-width="${p.strokeW * 0.7}" stroke-linejoin="round"`;
  switch (item) {
    case "crown":
      return `<path d="M ${cx - r * 0.75} ${top + 3} L ${cx - r * 0.75} ${top - 5} L ${cx - r * 0.35} ${top} L ${cx} ${top - 7} L ${cx + r * 0.35} ${top} L ${cx + r * 0.75} ${top - 5} L ${cx + r * 0.75} ${top + 3} Z" fill="${p.crown}" ${sw}/>`;
    case "helmet":
      return `<path d="M ${cx - r - 1} ${cy - 1} A ${r + 1} ${r + 1} 0 0 1 ${cx + r + 1} ${cy - 1} Z" fill="${p.helmet}" ${sw}/><path d="M ${cx} ${cy - 1} L ${cx} ${cy + r * 0.7}" ${sw} fill="none"/>`;
    case "hat": // chef toque: a band + a puffy top
      return `<rect x="${cx - r * 0.7}" y="${top - 2}" width="${r * 1.4}" height="5" rx="1.5" fill="${p.hat}" ${sw}/><path d="M ${cx - r * 0.7} ${top - 2} C ${cx - r} ${top - 16}, ${cx - r * 0.2} ${top - 18}, ${cx} ${top - 12} C ${cx + r * 0.2} ${top - 18}, ${cx + r} ${top - 16}, ${cx + r * 0.7} ${top - 2} Z" fill="${p.hat}" ${sw}/>`;
    default: // hair tuft
      return `<path d="M ${cx - r * 0.55} ${top + 3} L ${cx - r * 0.35} ${top - 4} L ${cx - r * 0.1} ${top + 1} L ${cx + r * 0.15} ${top - 5} L ${cx + r * 0.35} ${top + 1} L ${cx + r * 0.5} ${top - 3}" stroke="${p.stroke}" stroke-width="${p.strokeW * 0.8}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
}

/** SVG for one figure in its local 100×150 box. */
function figureSvg(spec: FigureSpec, p: Palette): string {
  const j = POSES[spec.pose];
  const parts: string[] = [];
  // limbs (draw before head so the head sits on top)
  parts.push(line(j.shoulder, j.hip, p)); // torso
  parts.push(line(j.shoulder, j.elbowL, p), line(j.elbowL, j.handL, p));
  parts.push(line(j.shoulder, j.elbowR, p), line(j.elbowR, j.handR, p));
  parts.push(line(j.hip, j.kneeL, p), line(j.kneeL, j.footL, p));
  parts.push(line(j.hip, j.kneeR, p), line(j.kneeR, j.footR, p));
  // head
  parts.push(`<circle cx="${j.head[0]}" cy="${j.head[1]}" r="${j.headR}" fill="${p.headFill}" stroke="${p.stroke}" stroke-width="${p.strokeW}"/>`);
  parts.push(headwear(j.head, j.headR, spec.headItem ?? "none", p));
  parts.push(face(j.head, j.headR, spec.expression ?? "neutral", p));
  return parts.join("");
}

/** Place a figure's local box on the WxH canvas via translate+scale (+flip). */
function placed(spec: FigureSpec, body: string, W: number, H: number): string {
  const scale = spec.scale ?? 0.62;
  const s = (scale * H) / 150;
  const cx = (spec.x ?? 0.5) * W;
  const anchorY = 0.94; // feet near the bottom
  const tx = cx - (100 * s) / 2;
  const ty = anchorY * H - 150 * s;
  const transform = spec.flip
    ? `translate(${tx + 100 * s} ${ty}) scale(${-s} ${s})`
    : `translate(${tx} ${ty}) scale(${s})`;
  return `<g transform="${transform}">${body}</g>`;
}

function buildSvg(input: RenderStickmanInput, p: Palette, background: string): string {
  const { width: W, height: H } = input;
  const bodies = input.figures.map((f) => placed(f, figureSvg(f, p), W, H)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${background}${bodies}</svg>`;
}

async function rasterise(svg: string): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Render the shot's figure(s) twice: a transparent coloured cut-out (Way A) and
 * a black-line-on-white control image (Way B). Deterministic — same input always
 * yields the same bytes.
 */
export async function renderStickman(input: RenderStickmanInput): Promise<{ figurePng: Buffer; controlPng: Buffer }> {
  const colourSvg = buildSvg(input, COLOR, ""); // transparent background
  const controlSvg = buildSvg(input, LINE, `<rect width="${input.width}" height="${input.height}" fill="#ffffff"/>`);
  const [figurePng, controlPng] = await Promise.all([rasterise(colourSvg), rasterise(controlSvg)]);
  return { figurePng, controlPng };
}

/** Exposed for tests/preview: the raw SVG (colour or line), no rasterisation. */
export function stickmanSvg(input: RenderStickmanInput, mode: "colour" | "line" = "colour"): string {
  return mode === "line"
    ? buildSvg(input, LINE, `<rect width="${input.width}" height="${input.height}" fill="#ffffff"/>`)
    : buildSvg(input, COLOR, "");
}

/** All pose names — handy for the preview sheet and for validating writer output. */
export const POSE_NAMES = Object.keys(POSES) as PoseName[];

export interface SheetCell {
  label: string;
  figures: FigureSpec[];
}

/**
 * Render a labelled grid of figures into one PNG for eyeballing (preview/tests).
 * Kept here so all sharp usage stays inside this package (it won't resolve from a
 * root-level script).
 */
export async function buildStickmanSheetPng(cells: SheetCell[], opts?: { cell?: number; cols?: number }): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const CELL = opts?.cell ?? 220;
  const COLS = opts?.cols ?? 5;
  const rows = Math.max(1, Math.ceil(cells.length / COLS));
  const tiles = await Promise.all(
    cells.map(async (c) => {
      const fig = stickmanSvg({ figures: c.figures, width: CELL, height: CELL }, "colour");
      const label = c.label.replace(/[<&>]/g, "");
      const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}"><rect width="${CELL}" height="${CELL}" fill="#fbf6ea"/><rect width="${CELL}" height="18" fill="#141414"/><text x="6" y="13" font-family="monospace" font-size="12" fill="#ffffff">${label}</text></svg>`;
      return sharp(Buffer.from(bg)).composite([{ input: Buffer.from(fig), top: 0, left: 0 }]).png().toBuffer();
    }),
  );
  const canvas = sharp({ create: { width: COLS * CELL, height: rows * CELL, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } });
  const composites = tiles.map((input, i) => ({ input, top: Math.floor(i / COLS) * CELL, left: (i % COLS) * CELL }));
  return canvas.composite(composites).png().toBuffer();
}
