import type { TtsProvider, TtsResult, TtsWord } from "./types.js";

export interface ElevenLabsTtsOptions {
  apiKey: string;
  /** Voice id from your ElevenLabs account. */
  voiceId: string;
  model?: string;
  /**
   * Voice stability 0..1. LOW (0.0 "Creative") maximizes emotional range but makes
   * SEPARATE requests drift — which is why the chunks of a long narration sounded
   * different. ~0.5 keeps them consistent while staying natural. Default 0.5.
   */
  stability?: number;
}

/** ElevenLabs character-alignment payload (from the with-timestamps endpoint). */
export interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * Fold ElevenLabs' per-character alignment into spoken-word timings: a word runs
 * from its first character's start to its last character's end, split on
 * whitespace. Bracketed audio tags ("[excited]") are dropped — they aren't
 * spoken, so captions must not show or time to them. Pure, so it's unit-tested.
 */
export function alignmentToWords(a: CharAlignment): TtsWord[] {
  const words: TtsWord[] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  let inTag = false;
  const flush = () => {
    if (cur.trim()) words.push({ word: cur, start, end });
    cur = "";
  };
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i]!;
    if (ch === "[") { inTag = true; flush(); continue; }
    if (ch === "]") { inTag = false; continue; }
    if (inTag) continue;
    if (/\s/.test(ch)) { flush(); continue; }
    if (!cur) start = a.character_start_times_seconds[i] ?? end;
    cur += ch;
    end = a.character_end_times_seconds[i] ?? start;
  }
  flush();
  return words;
}

/**
 * ElevenLabs text-to-speech, defaulting to `eleven_v3`. Uses the with-timestamps
 * endpoint so captions can sync exactly to the spoken words (v3's inline audio
 * tags otherwise make proportional caption timing drift). Stability 0.0
 * ("Creative") maximizes range for tagged reads.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly model: string;
  private readonly stability: number;
  readonly speaksTags: boolean;
  /** eleven_v3 rejects previous_text/next_text ("unsupported_model", 400). Only
   *  the v2-era models accept the neighbour-conditioning params. */
  private readonly supportsContext: boolean;

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    this.model = opts.model || "eleven_v3";
    this.speaksTags = this.model.startsWith("eleven_v3");
    this.supportsContext = !this.model.startsWith("eleven_v3");
    // 0.5 ("Natural") by default — consistent across the chunks of one narration.
    this.stability = opts.stability ?? 0.5;
  }

  async synthesize(input: { text: string; voice?: string; previousText?: string; nextText?: string }): Promise<TtsResult> {
    const voice = input.voice || this.opts.voiceId;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps`, {
      method: "POST",
      headers: {
        "xi-api-key": this.opts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: input.text,
        model_id: this.model,
        // Condition each chunk on its neighbours so a long narration's chunks match
        // in tone/prosody at the joins instead of each starting cold. Only sent on
        // models that accept it — eleven_v3 rejects these params (400).
        ...(this.supportsContext && input.previousText ? { previous_text: input.previousText } : {}),
        ...(this.supportsContext && input.nextText ? { next_text: input.nextText } : {}),
        // A fixed seed makes generations more reproducible/consistent request to request.
        seed: 12345,
        voice_settings: this.speaksTags
          ? { stability: this.stability, use_speaker_boost: true }
          : { stability: this.stability, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { audio_base64?: string; alignment?: CharAlignment };
    if (!json.audio_base64) throw new Error("ElevenLabs returned no audio");
    const words = json.alignment ? alignmentToWords(json.alignment) : undefined;
    return { audio: Buffer.from(json.audio_base64, "base64"), ext: "mp3", words };
  }
}
