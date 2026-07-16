import type { TtsProvider } from "./types.js";

export interface ElevenLabsTtsOptions {
  apiKey: string;
  /** Voice id from your ElevenLabs account. */
  voiceId: string;
  model?: string;
}

/**
 * ElevenLabs text-to-speech. Optional alternative to the OpenAI default: the
 * most human-sounding read available (breaths, micro-prosody), at roughly 10x
 * the cost. Worth switching to per-video for clips that carry a channel.
 *
 * Note: no delivery `instructions` — tone comes from the chosen voice and the
 * script itself, so the writing has to carry more of the personality here.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  private readonly model: string;

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    this.model = opts.model || "eleven_turbo_v2_5";
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
        voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35 },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), ext: "mp3" };
  }
}
