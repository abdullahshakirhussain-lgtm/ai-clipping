import { isRateLimited, MAX_RATE_LIMIT_WAITS, retryAfterMs } from "./google-video.js";
import type { CallAudioProvider, CallAudioResult, CallSpeaker } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * POST with rate-limit backoff. A call is two chained requests (write the
 * dialogue, then perform it), so a 429 on either one loses the whole call —
 * including, on the second, the text already generated and paid for.
 */
async function postWithBackoff(url: string, apiKey: string, body: unknown, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    if ((isRateLimited(res.status) || res.status >= 500) && attempt < MAX_RATE_LIMIT_WAITS) {
      const wait = retryAfterMs(res.headers, attempt);
      console.warn(`[${label}] ${res.status}; waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    return res;
  }
}

export interface GoogleCallOptions {
  apiKey: string;
  /** Gemini TTS model — multi-speaker capable. */
  ttsModel?: string;
  /** Gemini text model that improvises the dialogue from the brief. */
  textModel?: string;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Call Studio audio, entirely on Google (Gemini API direct — same key and host
 * as Veo, so adding GEMINI_API_KEY is the only setup):
 *
 *   1. a text model IMPROVISES the dialogue from the approved brief. The brief
 *      never contains lines — written dialogue performs like written dialogue,
 *      and the whole genre lives or dies on sounding like a real recording.
 *   2. a multi-speaker TTS model performs it, one voice per speaker, with the
 *      accent/tempo direction carried in the prompt (Gemini TTS is steered in
 *      natural language, not by parameters).
 *
 * Output is raw 24kHz mono 16-bit PCM, wrapped here into a .wav so ffmpeg reads
 * it directly. Cheap enough to iterate on: ~$10/M audio output tokens puts a
 * 60-second call around 2 cents.
 */
/** Text models tried in order when the configured one is gone (404). Google
 *  periodically retires models for new accounts (e.g. gemini-2.5-flash), so the
 *  dialogue writer falls through this list rather than hard-failing the call. */
const FALLBACK_TEXT_MODELS = ["gemini-flash-latest", "gemini-2.0-flash"];

export class GoogleCallProvider implements CallAudioProvider {
  private readonly ttsModel: string;
  private readonly textModel: string;
  /** The model that actually worked, cached after the first success. */
  private resolvedTextModel?: string;

  constructor(private readonly opts: GoogleCallOptions) {
    this.ttsModel = opts.ttsModel || "gemini-2.5-flash-preview-tts";
    this.textModel = opts.textModel || "gemini-flash-latest";
  }

  async generate(input: {
    brief: string;
    speakers: CallSpeaker[];
    targetSeconds: number;
  }): Promise<CallAudioResult> {
    if (input.speakers.length < 2) throw new Error("call audio needs 2 speakers");
    const [a, b] = input.speakers as [CallSpeaker, CallSpeaker];
    const words = Math.round((input.targetSeconds / 60) * 150);

    // 1. Improvise the call.
    const transcript = await this.writeDialogue(input.brief, a, b, words);
    const lines = parseLines(transcript, [a.name, b.name]);
    if (lines.length < 2) throw new Error(`call writer returned no usable dialogue: ${transcript.slice(0, 200)}`);

    // 2. Perform it. The style prefix is what carries accent, tempo and the
    //    "this is a phone recording" framing — the config only picks voices.
    const direction = [
      `TTS the following recorded phone call between ${a.name} and ${b.name}.`,
      `Perform it as a real, unscripted phone recording — natural overlaps, interruptions, breaths and pauses. Never sound like a narrator reading.`,
      `${a.name}: ${a.direction}`,
      `${b.name}: ${b.direction}`,
      ``,
      lines.map((l) => `${l.speaker}: ${l.text}`).join("\n"),
    ].join("\n");

    const { pcm, sampleRate } = await this.speak(direction, [a, b]);
    return {
      audio: pcmToWav(pcm, sampleRate),
      ext: "wav",
      transcript: lines.map((l) => `${l.speaker}: ${l.text}`).join("\n"),
      lines,
    };
  }

  /** Confirms the configured models exist for this key — no generation, no spend. */
  async check(): Promise<{ ok: boolean; models: Array<{ id: string; ok: boolean; detail: string }> }> {
    const models = await Promise.all([checkModel(this.opts.apiKey, this.textModel), checkModel(this.opts.apiKey, this.ttsModel)]);
    return { ok: models.every((m) => m.ok), models };
  }

  private async writeDialogue(brief: string, a: CallSpeaker, b: CallSpeaker, words: number): Promise<string> {
    const prompt = `You are writing the actual spoken dialogue for the recorded phone call briefed below. This is for a clearly fictional, AI-made short video.

${brief}

OUTPUT RULES — follow exactly:
- Output ONLY dialogue lines, one per line, in the form "${a.name}: ..." or "${b.name}: ...". No headings, no stage directions in brackets, no narration, no markdown.
- Use ONLY those two speaker labels, spelled exactly like that.
- About ${words} words total. Short lines. Real calls are made of half-sentences, not paragraphs.
- Start mid-situation — no "hello, this is a recording", no scene setting.
- People interrupt, repeat themselves, mishear, sigh, say "hello? are you there?", talk over each other. Write that in.
- Keep every hard rule in the brief. Everyone is fictional; no real people, companies or numbers.
- End where the brief says it ends — cut on the peak, no resolution, no closing quip.`;

    // Try the configured model, then fall through the fallbacks on a 404 (model
    // retired) — other errors are real, so stop on them. Cache the winner.
    const candidates = this.resolvedTextModel
      ? [this.resolvedTextModel]
      : [...new Set([this.textModel, ...FALLBACK_TEXT_MODELS])];
    let last: { status: number; detail: string } | null = null;
    for (const model of candidates) {
      const res = await postWithBackoff(
        `${BASE}/models/${model}:generateContent`,
        this.opts.apiKey,
        {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0, maxOutputTokens: 2048 },
        },
        "gemini-dialogue",
      );
      if (res.ok) {
        this.resolvedTextModel = model;
        const j = (await res.json()) as GenerateContentResponse;
        const text = (j.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? "")
          .join("")
          .trim();
        if (!text) throw new Error("Gemini dialogue call returned no text");
        return text;
      }
      last = { status: res.status, detail: await res.text().catch(() => "") };
      if (res.status !== 404) break; // real error, not a retired model
      console.warn(`[gemini-dialogue] model ${model} unavailable (404); trying next`);
    }
    throw new Error(`Gemini dialogue call failed (${last?.status}): ${(last?.detail ?? "").slice(0, 300)}`);
  }

  private async speak(text: string, speakers: CallSpeaker[]): Promise<{ pcm: Buffer; sampleRate: number }> {
    const res = await postWithBackoff(
      `${BASE}/models/${this.ttsModel}:generateContent`,
      this.opts.apiKey,
      {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: speakers.map((s) => ({
                speaker: s.name,
                voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } },
              })),
            },
          },
        },
      },
      "gemini-tts",
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini TTS failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const j = (await res.json()) as GenerateContentResponse;
    const part = (j.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("Gemini TTS returned no audio");
    return {
      pcm: Buffer.from(part.inlineData.data, "base64"),
      sampleRate: rateFromMime(part.inlineData.mimeType),
    };
  }
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> };
  }>;
}

/** GET a model definition — the cheapest possible "does this key see this model" probe. */
export async function checkModel(apiKey: string, model: string): Promise<{ id: string; ok: boolean; detail: string }> {
  if (!apiKey) return { id: model, ok: false, detail: "no GEMINI_API_KEY set" };
  try {
    const res = await fetch(`${BASE}/models/${model}`, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { id: model, ok: false, detail: `${res.status}: ${body.slice(0, 200)}` };
    }
    const j = (await res.json()) as { displayName?: string; supportedGenerationMethods?: string[] };
    const methods = j.supportedGenerationMethods ?? [];
    return {
      id: model,
      ok: true,
      detail: `${j.displayName ?? model}${methods.length ? ` — ${methods.join(", ")}` : ""}`,
    };
  } catch (err) {
    return { id: model, ok: false, detail: String(err).slice(0, 200) };
  }
}

/** "audio/L16;codec=pcm;rate=24000" → 24000 (Gemini TTS is 24k, but read it anyway). */
function rateFromMime(mime?: string): number {
  const m = /rate=(\d+)/.exec(mime ?? "");
  return m ? Number(m[1]) : 24000;
}

/** Wrap raw signed 16-bit PCM in a WAV container so ffmpeg reads it directly. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Pull "Name: line" pairs out of the writer's output. Anything before the first
 * recognised speaker (a stray preamble) is dropped, and a continuation line with
 * no label is appended to the speaker above it.
 */
export function parseLines(text: string, names: string[]): Array<{ speaker: string; text: string }> {
  const lines: Array<{ speaker: string; text: string }> = [];
  const lower = names.map((n) => n.toLowerCase());
  // Models like to bold the speaker ("**Dave:** listen"); strip emphasis so the
  // asterisks don't end up spoken or burned into the captions.
  const clean = (s: string) => s.replace(/[*_`]/g, "").trim();
  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw.replace(/^[\s>-]+/, ""));
    if (!line) continue;
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (m) {
      const idx = lower.indexOf(clean(m[1]!).toLowerCase());
      if (idx >= 0) {
        lines.push({ speaker: names[idx]!, text: clean(m[2]!) });
        continue;
      }
    }
    if (lines.length > 0) lines[lines.length - 1]!.text += ` ${line}`;
  }
  return lines;
}
