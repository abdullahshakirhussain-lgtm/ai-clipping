/**
 * The fake phone-call SCREEN for Call Studio: a deterministic, code-drawn card
 * showing both parties on the line with the ACTIVE speaker lit up (bright avatar,
 * coloured ring, a little waveform) and the other dimmed. A call is audio-led, so
 * the visual only has to say "these two people are on a call, and THIS one is
 * talking" — which is exactly the genre's convention.
 *
 * Fully deterministic (SVG → sharp, same pattern as buildOutroCard), so the two
 * states (left-active / right-active) are built once per call and reused for every
 * line — no image-model spend at all. sharp is loaded lazily like the rest of the
 * package.
 */

export interface CallScreenOpts {
  width: number;
  height: number;
  /** Speaker 0's name (drawn on the left). */
  left: string;
  /** Speaker 1's name (drawn on the right). */
  right: string;
  /** 0 = left is talking, 1 = right is talking. */
  active: number;
}

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

/** Up to two initials from a name ("Dave Miller" → "DM", "aldith" → "A"). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + second).toUpperCase();
}

/** One party: avatar circle + initials + name, lit when talking, dimmed when not. */
function party(cx: number, cy: number, r: number, name: string, talking: boolean, accent: string): string {
  const op = talking ? 1 : 0.4;
  const ring = talking ? `<circle cx="${cx}" cy="${cy}" r="${r + r * 0.14}" fill="none" stroke="${accent}" stroke-width="${Math.max(2, r * 0.09)}"/>` : "";
  const nameY = cy + r + r * 0.55;
  const wave = talking ? waveform(cx, cy + r + r * 0.95, r) : "";
  return (
    `<g opacity="${op}">` +
    ring +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#2a2f3a"/>` +
    `<text x="${cx}" y="${cy + r * 0.34}" font-size="${r * 0.9}" font-weight="bold" text-anchor="middle" fill="#f4f6fb">${escapeXml(initials(name))}</text>` +
    `<text x="${cx}" y="${nameY}" font-size="${r * 0.42}" text-anchor="middle" fill="#c9cfda">${escapeXml(name)}</text>` +
    `</g>` +
    wave
  );
}

/** Five little bars, fixed heights, so the talking side visibly "sounds". */
function waveform(cx: number, cy: number, r: number): string {
  const heights = [0.35, 0.7, 1, 0.55, 0.4];
  const bw = r * 0.12;
  const gap = r * 0.1;
  const totalW = heights.length * bw + (heights.length - 1) * gap;
  let x = cx - totalW / 2;
  const bars = heights
    .map((h) => {
      const bh = r * 0.55 * h;
      const rect = `<rect x="${x.toFixed(1)}" y="${(cy - bh / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${(bw / 2).toFixed(1)}" fill="#37d24c"/>`;
      x += bw + gap;
      return rect;
    })
    .join("");
  return `<g>${bars}</g>`;
}

/**
 * Render one call-screen frame. Colours match the two-speaker caption palette
 * (speaker 0 white-ish, speaker 1 amber) so the talking side and its captions
 * agree at a glance.
 */
export async function buildCallScreen(opts: CallScreenOpts): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const { width: W, height: H, left, right, active } = opts;

  const r = Math.min(W, H) * 0.13;
  const cy = H * 0.3;
  const lx = W * 0.29;
  const rx = W * 0.71;
  const headerY = H * 0.13;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#171b24"/><stop offset="1" stop-color="#0d0f15"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    // header: "on the line" with a live dot
    `<g font-family="Arial, sans-serif">` +
    `<circle cx="${W / 2 - r * 1.7}" cy="${headerY - r * 0.12}" r="${Math.max(4, r * 0.09)}" fill="#37d24c"/>` +
    `<text x="${W / 2}" y="${headerY}" font-size="${r * 0.4}" text-anchor="middle" fill="#8b93a3" letter-spacing="2">ON THE LINE</text>` +
    party(lx, cy, r, left, active === 0, "#f4f6fb") +
    party(rx, cy, r, right, active === 1, "#ffc542") +
    `</g></svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
