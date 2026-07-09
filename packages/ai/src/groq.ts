import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { TranscriptionProvider, TranscriptionResult, TranscriptSegment } from "./types.js";

export interface GroqWhisperOptions {
  apiKey: string;
  model?: string;
}

interface GroqVerboseResponse {
  language?: string;
  text: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ start: number; end: number; word: string }>;
}

/**
 * Groq-hosted Whisper via the OpenAI-compatible audio transcription endpoint.
 * verbose_json gives segment + word timestamps needed for caption alignment.
 */
export class GroqWhisperProvider implements TranscriptionProvider {
  constructor(private readonly opts: GroqWhisperOptions) {}

  async transcribe(localFilePath: string): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", await openAsBlob(localFilePath), basename(localFilePath));
    form.append("model", this.opts.model ?? "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Groq transcription failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as GroqVerboseResponse;

    const words = data.words ?? [];
    const segments: TranscriptSegment[] = (data.segments ?? []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
      words: words
        .filter((w) => w.start >= s.start && w.end <= s.end + 0.5)
        .map((w) => ({ start: w.start, end: w.end, word: w.word })),
    }));

    return {
      language: data.language ?? "en",
      text: data.text,
      segments,
      provider: `groq/${this.opts.model ?? "whisper-large-v3-turbo"}`,
    };
  }
}
