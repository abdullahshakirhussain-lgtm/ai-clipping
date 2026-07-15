import { readFile } from "node:fs/promises";
import type { TranscriptionProvider, TranscriptionResult, TranscriptSegment } from "./types.js";

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
}

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}

/**
 * WAVE 3 SCAFFOLD — Deepgram prerecorded transcription with speaker diarization.
 *
 * Drop-in `TranscriptionProvider` that returns word-level timestamps AND speaker
 * labels (unlike Groq Whisper). Wired via TRANSCRIBE_PROVIDER=deepgram +
 * DEEPGRAM_API_KEY. Implemented against Deepgram's documented API but NOT yet
 * verified against a live key — validate once the key is added.
 */
export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: DeepgramOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "nova-2";
  }

  async transcribe(localFilePath: string): Promise<TranscriptionResult> {
    const audio = await readFile(localFilePath);
    const params = new URLSearchParams({
      model: this.model,
      smart_format: "true",
      diarize: "true",
      punctuate: "true",
      utterances: "true",
    });
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "audio/mpeg" },
      body: audio,
    });
    if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as {
      results?: {
        utterances?: Array<{ start: number; end: number; transcript: string; speaker?: number; words?: DgWord[] }>;
        channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: DgWord[] }> }>;
      };
    };

    const mapWords = (ws: DgWord[] = []) =>
      ws.map((w) => ({ start: w.start, end: w.end, word: w.punctuated_word ?? w.word }));

    // Prefer utterances (already split per speaker turn).
    const utterances = data.results?.utterances ?? [];
    const segments: TranscriptSegment[] = utterances.map((u) => ({
      start: u.start,
      end: u.end,
      text: u.transcript,
      speaker: u.speaker != null ? String(u.speaker) : undefined,
      words: mapWords(u.words),
    }));

    const alt = data.results?.channels?.[0]?.alternatives?.[0];
    if (segments.length === 0 && alt?.words?.length) {
      // Fallback: chunk raw words into ~8-word segments.
      const words = alt.words;
      for (let i = 0; i < words.length; i += 8) {
        const chunk = words.slice(i, i + 8);
        segments.push({
          start: chunk[0]!.start,
          end: chunk[chunk.length - 1]!.end,
          text: chunk.map((w) => w.punctuated_word ?? w.word).join(" "),
          speaker: chunk[0]!.speaker != null ? String(chunk[0]!.speaker) : undefined,
          words: mapWords(chunk),
        });
      }
    }

    return {
      language: "en",
      text: alt?.transcript ?? segments.map((s) => s.text).join(" "),
      segments,
      provider: "deepgram",
    };
  }
}
