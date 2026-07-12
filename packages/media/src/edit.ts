import { CAPTION_STYLES, type CaptionWord } from "./captions.js";

/** A span of the source clip to KEEP (source-time seconds). Gaps between spans are cut. */
export interface KeepSpan {
  s: number;
  e: number;
}

export interface EditPlan {
  /** Keep spans in CLIP-RELATIVE time (0 = clip start), for ffmpeg's select filter. */
  selectSpans: KeepSpan[];
  /** Total duration after cuts, seconds. */
  clipDurationSec: number;
  /** Karaoke + hook-overlay ASS, timed in POST-CUT clip time. Empty if no words. */
  ass: string;
  /** How many seconds of dead air / filler were removed. */
  removedSec: number;
  /** Map a source-absolute time to POST-CUT clip time, or null if it was cut. */
  mapSourceTime: (sourceSec: number) => number | null;
}

/** Leading filler words trimmed off the very start so clips open on the hook. */
const LEADING_FILLERS = new Set([
  "um", "uh", "er", "ah", "hmm", "so", "and", "but", "like", "okay", "ok", "well", "yeah", "right",
]);

const ASS_HIGHLIGHT = "&H0000E5FF"; // amber (BBGGRR) — the "sung" word
const ASS_BASE = "&H00FFFFFF"; // white — upcoming words

export type CaptionPosition = "top" | "middle" | "bottom";

/** Selectable caption looks (maps to CAPTION_STYLES) shown in the UI. */
export const CAPTION_STYLE_OPTIONS = ["bold-center", "yellow-pop", "clean-bottom"] as const;

/** Vertical placement → ASS alignment (numpad) + vertical margin. */
const POSITION_MAP: Record<CaptionPosition, { alignment: number; marginV: number }> = {
  top: { alignment: 8, marginV: 240 },
  middle: { alignment: 5, marginV: 0 },
  bottom: { alignment: 2, marginV: 260 },
};

const assTime = (sec: number): string => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
};

const escapeAss = (t: string) => t.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");

/**
 * Plans the edit for one clip from its word timestamps:
 *  - trims leading filler words (open on the hook),
 *  - removes internal silence gaps longer than `maxGapSec` (jump-cuts),
 *  - re-times the surviving words into post-cut clip time,
 *  - emits karaoke-style word-by-word ASS plus an optional first-frame hook banner.
 *
 * With no usable words (e.g. non-speech clips) it returns a single full span and
 * no captions, so the caller renders the window unchanged.
 */
export function planClipEdit(input: {
  words: CaptionWord[];
  clipStart: number;
  clipEnd: number;
  styleName?: string;
  position?: CaptionPosition;
  hookText?: string;
  maxGapSec?: number;
  padSec?: number;
  wordsPerLine?: number;
  hookSeconds?: number;
}): EditPlan {
  const clipDur = Math.max(0, input.clipEnd - input.clipStart);
  const maxGap = input.maxGapSec ?? 0.4;
  const pad = input.padSec ?? 0.06;
  const wordsPerLine = input.wordsPerLine ?? 4;
  const hookSeconds = input.hookSeconds ?? 2.5;

  // Words inside the window, clamped and sorted.
  let words = input.words
    .filter((w) => w.end > input.clipStart && w.start < input.clipEnd && w.word.trim())
    .map((w) => ({
      start: Math.max(w.start, input.clipStart),
      end: Math.min(w.end, input.clipEnd),
      word: w.word.trim(),
    }))
    .sort((a, b) => a.start - b.start);

  // Trim up to 4 leading filler words so the clip opens on real content.
  let trimmed = 0;
  while (words.length > 1 && trimmed < 4 && LEADING_FILLERS.has(words[0]!.word.toLowerCase().replace(/[^a-z]/g, ""))) {
    words.shift();
    trimmed += 1;
  }

  // No usable speech → keep the whole window, no captions, linear time map.
  if (words.length === 0) {
    return {
      selectSpans: [{ s: 0, e: clipDur }],
      clipDurationSec: clipDur,
      ass: input.hookText ? hookOnlyAss(input.hookText, clipDur, hookSeconds) : "",
      removedSec: 0,
      mapSourceTime: (t) => (t >= input.clipStart && t <= input.clipEnd ? t - input.clipStart : null),
    };
  }

  // Build keep spans (source time): bridge small gaps, cut large ones.
  const spans: KeepSpan[] = [];
  let cur: KeepSpan = { s: words[0]!.start - pad, e: words[0]!.end + pad };
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.start - cur.e > maxGap) {
      spans.push(cur);
      cur = { s: w.start - pad, e: w.end + pad };
    } else {
      cur.e = w.end + pad;
    }
  }
  spans.push(cur);
  // Clamp to the window.
  for (const sp of spans) {
    sp.s = Math.max(input.clipStart, sp.s);
    sp.e = Math.min(input.clipEnd, sp.e);
  }

  // Source-time → post-cut clip-time mapping.
  const prefix: number[] = [];
  let acc = 0;
  for (const sp of spans) {
    prefix.push(acc);
    acc += sp.e - sp.s;
  }
  const keptDur = acc;
  const mapTime = (t: number): number => {
    for (let k = 0; k < spans.length; k++) {
      const sp = spans[k]!;
      if (t <= sp.e) return prefix[k]! + Math.max(0, t - sp.s);
    }
    return keptDur;
  };

  // Re-time words into post-cut clip time.
  const cutWords = words.map((w) => ({ word: w.word, start: mapTime(w.start), end: mapTime(w.end) }));

  const styleName = input.styleName && CAPTION_STYLES[input.styleName] ? input.styleName : "bold-center";
  const position = input.position ?? "bottom";
  const ass = buildKaraokeAss(cutWords, keptDur, styleName, position, wordsPerLine, input.hookText, hookSeconds);

  return {
    selectSpans: spans.map((sp) => ({ s: sp.s - input.clipStart, e: sp.e - input.clipStart })),
    clipDurationSec: keptDur,
    ass,
    removedSec: Math.max(0, clipDur - keptDur),
    // Source-absolute time → post-cut clip time; null if the moment was cut out.
    mapSourceTime: (t) => {
      for (let k = 0; k < spans.length; k++) {
        const sp = spans[k]!;
        if (t >= sp.s && t <= sp.e) return prefix[k]! + (t - sp.s);
      }
      return null;
    },
  };
}

interface CutWord {
  word: string;
  start: number;
  end: number;
}

function buildKaraokeAss(
  words: CutWord[],
  clipDur: number,
  styleName: string,
  position: CaptionPosition,
  wordsPerLine: number,
  hookText: string | undefined,
  hookSeconds: number,
): string {
  const style = CAPTION_STYLES[styleName] ?? CAPTION_STYLES["bold-center"]!;
  const place = POSITION_MAP[position] ?? POSITION_MAP.bottom;
  const events: string[] = [];

  // Group into short lines; also break a line when a big pause precedes a word.
  const lines: CutWord[][] = [];
  let line: CutWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = line[line.length - 1];
    if (line.length >= wordsPerLine || (prev && w.start - prev.end > 0.6)) {
      if (line.length) lines.push(line);
      line = [];
    }
    line.push(w);
  }
  if (line.length) lines.push(line);

  for (const ln of lines) {
    const start = ln[0]!.start;
    const end = ln[ln.length - 1]!.end;
    if (end <= start) continue;
    // Native ASS karaoke: each \k advances the highlight by that many centiseconds.
    const parts = ln.map((w, i) => {
      const next = ln[i + 1];
      const durCs = Math.max(1, Math.round(((next ? next.start : end) - w.start) * 100));
      return `{\\k${durCs}}${escapeAss(w.word.toUpperCase())} `;
    });
    events.push(
      `Dialogue: 0,${assTime(start)},${assTime(end)},Karaoke,,0,0,0,,${parts.join("").trimEnd()}`,
    );
  }

  if (hookText) events.push(hookEvent(hookText, clipDur, hookSeconds));

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,${style.fontName},${style.fontSize},${ASS_HIGHLIGHT},${ASS_BASE},${style.outlineColour},&H00000000,${style.bold ? -1 : 0},0,1,${style.outline},2,${place.alignment},60,60,${place.marginV},1
Style: Hook,${style.fontName},72,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB0000000,-1,0,3,4,0,8,80,80,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return header + events.join("\n") + "\n";
}

function hookEvent(hookText: string, clipDur: number, hookSeconds: number): string {
  const end = Math.min(clipDur, hookSeconds);
  const text = escapeAss(hookText).slice(0, 90).toUpperCase();
  return `Dialogue: 1,${assTime(0)},${assTime(end)},Hook,,0,0,0,,{\\fad(120,180)}${text}`;
}

function hookOnlyAss(hookText: string, clipDur: number, hookSeconds: number): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB0000000,-1,0,3,4,0,8,80,80,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return header + hookEvent(hookText, clipDur, hookSeconds) + "\n";
}
