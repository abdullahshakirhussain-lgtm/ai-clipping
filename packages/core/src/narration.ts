import type { TtsProvider, TtsWord } from "@clipfactory/ai";
import { concatAudio, probe } from "@clipfactory/media";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Chunk size for a single TTS request, in characters.
 *
 * gpt-4o-mini-tts caps input at 2000 TOKENS (~8000 chars), and ElevenLabs has
 * its own per-request ceiling. 4000 chars is roughly 1000 tokens — half the
 * tighter limit — which leaves room for the tokenizer being less efficient on
 * names and numbers than a chars/4 estimate suggests.
 */
const CHUNK_CHARS = 4000;

/**
 * Split narration into TTS-sized pieces at SENTENCE boundaries.
 *
 * Boundaries matter: a chunk that ends mid-sentence makes the next chunk start
 * cold, and the join is audible. Ending on a full stop puts the seam where the
 * reader would naturally pause anyway. Paragraphs are preferred over sentences,
 * and a single sentence longer than the limit is split on whitespace as a last
 * resort. Pure, so it's unit-tested.
 */
export function splitNarration(text: string, maxChars = CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // Sentence-ish units, keeping their terminator.
  const units: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    const sentences = p.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [p];
    for (const s of sentences) {
      const t = s.trim();
      if (t) units.push(t);
    }
  }

  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const unit of units) {
    if (unit.length > maxChars) {
      // Pathological single sentence — split on whitespace.
      push();
      let rest = unit;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(" ", maxChars);
        if (cut <= 0) cut = maxChars;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if (current.length + unit.length + 1 > maxChars) push();
    current = current ? `${current} ${unit}` : unit;
  }
  push();
  return chunks;
}

export interface NarrationResult {
  /** Path to the single continuous audio file. */
  audioFile: string;
  durationSec: number;
  /** Word timings when the provider supplies them, offset into whole-track time. */
  words?: TtsWord[];
}

/**
 * Record a narration of any length as ONE continuous track.
 *
 * Long-form runs to thousands of words, well past what a single TTS request
 * accepts — an 8-minute script sent in one call is rejected outright. This
 * synthesizes sentence-aligned chunks and joins them, so the caller still gets
 * one file and one timeline. Word timings from providers that return them are
 * shifted by each chunk's measured start, so captions stay aligned across joins
 * rather than restarting at zero on every chunk.
 */
export async function synthesizeNarration(input: {
  tts: TtsProvider;
  text: string;
  instructions?: string;
  voice?: string;
  workDir: string;
  /** Called after each chunk, for progress reporting. */
  onChunk?: (done: number, total: number) => Promise<void> | void;
}): Promise<NarrationResult> {
  const chunks = splitNarration(input.text);
  if (chunks.length === 0) throw new Error("synthesizeNarration: empty narration");

  const files: string[] = [];
  const words: TtsWord[] = [];
  let offset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const part = await input.tts.synthesize({
      text: chunks[i]!,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
    });
    const file = join(input.workDir, `narration-${i}.${part.ext}`);
    await fs.writeFile(file, part.audio);
    files.push(file);

    // Measure rather than trust: the offset for the next chunk's word timings
    // has to be this chunk's real duration.
    const measured = (await probe(file).catch(() => ({ durationSec: 0 }))).durationSec;
    if (part.words?.length) {
      for (const w of part.words) words.push({ word: w.word, start: w.start + offset, end: w.end + offset });
    }
    offset += measured;
    await input.onChunk?.(i + 1, chunks.length);
  }

  const audioFile = join(input.workDir, "narration.mp3");
  await concatAudio(files, audioFile, input.workDir);
  const probed = await probe(audioFile);
  return {
    audioFile,
    durationSec: probed.durationSec > 0 ? probed.durationSec : offset,
    ...(words.length > 0 ? { words } : {}),
  };
}
