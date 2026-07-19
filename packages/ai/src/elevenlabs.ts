import type { TtsProvider } from "./types.js";

export interface ElevenLabsTtsOptions {
  apiKey: string;
  /** Voice id from your ElevenLabs account. */
  voiceId: string;
  model?: string;
}

/**
 * ElevenLabs text-to-speech, defaulting to `eleven_v3` — the expressive model.
 * v3 is driven by audio tags inline in the text ("[scoffs] Five... [shouting]
 * THE JELLY."), which it performs rather than reads; `speaksTags` tells the
 * pipeline to leave them in. Stability 0.0 ("Creative") maximizes pitch and
 * emotional range; v3 ignores similarity/style/speed.
 *
 * Cost reality at our volume (~200 chars of commentary per clip): Starter
 * $6/mo ≈ 150 clips, Creator $22/mo ≈ 600 — not the old 300-clips/day scare
 * estimate. Delivery `instructions` are ignored; the writing carries the tags.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly model: string;
  readonly speaksTags: boolean;

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    this.model = opts.model || "eleven_v3";
    // Only v3 interprets audio tags; older models would read "[shouts]" aloud.
    this.speaksTags = this.model.startsWith("eleven_v3");
  }

  async synthesize(input: { text: string; voice?: string }): Promise<{ audio: Buffer; ext: "mp3" }> {
    const voice = input.voice || this.opts.voiceId;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.opts.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: input.text,
        model_id: this.model,
        voice_settings: this.speaksTags
          ? { stability: 0.0 } // Creative: widest emotional range for tagged reads
          : { stability: 0.4, similarity_boost: 0.75, style: 0.35 },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), ext: "mp3" };
  }
}
