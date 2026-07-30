export interface CaptionWord {
  start: number;
  end: number;
  word: string;
}

export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
  words?: CaptionWord[];
}

export interface CaptionStyleSpec {
  fontName: string;
  fontSize: number;
  /** Colour of un-spoken words (ASS &HAABBGGRR). */
  primaryColour: string;
  /** Colour a word turns as it's spoken (the karaoke highlight). */
  activeColour: string;
  outlineColour: string;
  outline: number;
  bold: boolean;
  /** ASS alignment (numpad layout): 2 = bottom-center, 5 = middle-center */
  alignment: number;
  marginV: number;
}

export const CAPTION_STYLES: Record<string, CaptionStyleSpec> = {
  // White words that light up amber as spoken.
  "bold-center": {
    fontName: "Arial",
    fontSize: 84,
    primaryColour: "&H00FFFFFF",
    activeColour: "&H0000E5FF",
    outlineColour: "&H00000000",
    outline: 5,
    bold: true,
    alignment: 5,
    marginV: 0,
  },
  // Smaller, subtle — white words that pop green.
  "clean-bottom": {
    fontName: "Arial",
    fontSize: 62,
    primaryColour: "&H00FFFFFF",
    activeColour: "&H0037D24C",
    outlineColour: "&H00000000",
    outline: 3,
    bold: false,
    alignment: 2,
    marginV: 260,
  },
  // Amber words that flip white as spoken (inverse of bold-center).
  "yellow-pop": {
    fontName: "Arial",
    fontSize: 84,
    primaryColour: "&H0000E5FF",
    activeColour: "&H00FFFFFF",
    outlineColour: "&H00000000",
    outline: 5,
    bold: true,
    alignment: 5,
    marginV: 0,
  },
};

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

const escapeAss = (text: string) => text.replace(/[{}]/g, "").replace(/\r?\n/g, " ");

/**
 * Builds an ASS subtitle document for one clip. Segment times are absolute in
 * the source video; `clipStart`/`clipEnd` shift them into clip-relative time.
 * When word timestamps exist, words are grouped into short punchy caption
 * chunks (short-form style); otherwise full segment texts are used.
 */
/** Independent caption placement: overrides the style's baked-in alignment/marginV. */
type CaptionPosition = "top" | "middle" | "bottom";
const POSITION_MAP: Record<CaptionPosition, { alignment: number; marginV: number }> = {
  top: { alignment: 8, marginV: 220 },
  middle: { alignment: 5, marginV: 0 },
  bottom: { alignment: 2, marginV: 260 },
};

/** Caption canvas. Defaults to 9:16 (1080x1920); pass 1920x1080 for long-form. */
export interface CaptionResolution {
  width: number;
  height: number;
}
const DEFAULT_RESOLUTION: CaptionResolution = { width: 1080, height: 1920 };

export function buildAss(
  segments: CaptionSegment[],
  clipStart: number,
  clipEnd: number,
  styleName = "bold-center",
  wordsPerChunk = 3,
  position?: CaptionPosition,
  resolution: CaptionResolution = DEFAULT_RESOLUTION,
): string {
  const style = CAPTION_STYLES[styleName] ?? CAPTION_STYLES["bold-center"]!;
  // Font sizes and margins are authored for a 1920-tall (9:16) canvas. On a
  // 1080-tall (16:9) canvas the same absolute values would render oversized, so
  // scale everything by the height ratio to keep captions the same FRACTION of
  // the frame regardless of aspect.
  const hScale = resolution.height / DEFAULT_RESOLUTION.height;
  const px = (v: number) => Math.max(1, Math.round(v * hScale));
  // Position, when given, wins over the style's default placement.
  const rawPlace = position ? POSITION_MAP[position] : { alignment: style.alignment, marginV: style.marginV };
  const place = { alignment: rawPlace.alignment, marginV: px(rawPlace.marginV) };
  const fontSize = px(style.fontSize);
  const outline = px(style.outline);
  const events: Array<{ start: number; end: number; text: string }> = [];

  for (const seg of segments) {
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    if (seg.words && seg.words.length > 0) {
      for (let i = 0; i < seg.words.length; i += wordsPerChunk) {
        const chunk = seg.words.slice(i, i + wordsPerChunk);
        const start = Math.max(chunk[0]!.start, clipStart);
        const end = Math.min(chunk[chunk.length - 1]!.end, clipEnd);
        if (end <= start) continue;
        events.push({
          start: start - clipStart,
          end: end - clipStart,
          text: chunk.map((w) => w.word).join(" ").trim(),
        });
      }
    } else {
      events.push({
        start: Math.max(seg.start, clipStart) - clipStart,
        end: Math.min(seg.end, clipEnd) - clipStart,
        text: seg.text,
      });
    }
  }

  const marginH = px(60);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${resolution.width}
PlayResY: ${resolution.height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${fontSize},${style.primaryColour},${style.outlineColour},&H00000000,${style.bold ? -1 : 0},0,1,${outline},1,${place.alignment},${marginH},${marginH},${place.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = events
    .map(
      (e) =>
        `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},Default,,0,0,0,,${escapeAss(e.text.toUpperCase())}`,
    )
    .join("\n");

  return header + lines + "\n";
}
