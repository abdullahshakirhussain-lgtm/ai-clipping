import type { TtsProvider } from "./types.js";

export interface OpenAiTtsOptions {
  apiKey: string;
  /** gpt-4o-mini-tts (steerable). Pin a snapshot for stable delivery. */
  model?: string;
  /** One of OpenAI's built-in voices (alloy, ash, ballad, coral, echo, …). */
  voice?: string;
}

/**
 * OpenAI text-to-speech. Default provider for the commentary track: it is
 * steerable via `instructions` (tone/pacing/attitude), which is what keeps the
 * read from sounding like a narrator bot, and roughly an order of magnitude
 * cheaper than ElevenLabs at our volume.
 */
export class OpenAiTtsProvider implements TtsProvider {
  private readonly model: string;
  private readonly defaultVoice: string;

  constructor(private readonly opts: OpenAiTtsOptions) {
    this.model = opts.model || "gpt-4o-mini-tts";
    this.defaultVoice = opts.voice || "ash";
  }

  async synthesize(input: {
    text: string;
    voice?: string;
    instructions?: string;
  }): Promise<{ audio: Buffer; ext: "mp3" }> {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        voice: input.voice || this.defaultVoice,
        input: input.text,
        // Delivery steering — the whole reason this model is the default.
        ...(input.instructions ? { instructions: input.instructions } : {}),
        response_format: "mp3",
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI TTS failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), ext: "mp3" };
  }
}
