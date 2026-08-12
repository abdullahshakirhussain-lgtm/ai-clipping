import { asArray, strList } from "./anthropic.js";
import { alignExpandedFrames, buildExpandFramesInstruction, buildImagePromptsInstruction, buildTopicsInstruction } from "./story-prompts.js";
import type { CheapTextProvider, ExpandImagePromptsInput, RefineImagePromptsInput, SuggestTopicsInput } from "./types.js";

export interface DeepSeekOptions {
  apiKey: string;
  /** DeepSeek model id — default "deepseek-chat" (the general V-series chat model);
   *  set DEEPSEEK_MODEL to the exact V4 Flash id if it differs. */
  model?: string;
  /** OpenAI-compatible base URL — default DeepSeek's. */
  baseUrl?: string;
}

/**
 * DeepSeek V4 Flash for the CHEAP text tasks — topic suggestions and the tight
 * image-prompt pass — at ~1/50th the cost of the Opus writer. OpenAI-compatible
 * chat/completions with JSON output. The narration itself stays on the Opus
 * writer (tone-critical); only these mechanical tasks route here.
 */
export class DeepSeekProvider implements CheapTextProvider {
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly opts: DeepSeekOptions) {
    this.model = opts.model || "deepseek-chat";
    this.baseUrl = (opts.baseUrl || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  }

  private async chatJson<T>(
    user: string,
    opts?: { temperature?: number; maxTokens?: number; timeoutMs?: number },
  ): Promise<T> {
    // Hard per-attempt timeout so a stalled connection fails fast rather than
    // hanging. DeepSeek normally answers in a few seconds.
    const timeoutMs = opts?.timeoutMs ?? 20000;
    const body = JSON.stringify({
      model: this.model,
      messages: [{ role: "user", content: user }],
      response_format: { type: "json_object" },
      temperature: opts?.temperature ?? 0.7,
      // V4 models emit reasoning_content before the answer; a tight cap gets
      // spent thinking and returns empty content, so budget generously.
      max_tokens: opts?.maxTokens ?? 8000,
    });

    // Retry transient failures — a TCP connect timeout (undici's 10s default) or
    // a 429/5xx — with backoff, so an occasional blip under concurrent batches
    // doesn't drop a call (which would fall back to a duplicated base prompt).
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
            lastErr = new Error(`deepseek ${res.status}: ${detail}`);
            await new Promise((r) => setTimeout(r, 600 * attempt));
            continue;
          }
          throw new Error(`deepseek ${res.status}: ${detail}`);
        }
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content?.trim() || "{}";
        return JSON.parse(content) as T;
      } catch (err) {
        if (controller.signal.aborted) throw new Error(`deepseek request timed out after ${timeoutMs}ms`);
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("deepseek request failed");
  }

  async suggestStoryTopics(input: SuggestTopicsInput): Promise<string[]> {
    const user = `${buildTopicsInstruction(input)}\n\nReturn JSON: {"topics": ["…", …]} — a flat array of strings.`;
    // Interactive path (the Suggest button) — keep the ceiling low so a slow host
    // network falls back to the main LLM well before the client gives up.
    const result = await this.chatJson<{ topics?: unknown }>(user, { temperature: 1, timeoutMs: 10000 });
    return strList(result.topics).map((s) => s.trim()).filter(Boolean).slice(0, input.count);
  }

  async refineImagePrompts(input: RefineImagePromptsInput): Promise<string[]> {
    if (input.beats.length === 0) return [];
    const user = `${buildImagePromptsInstruction(input)}\n\nReturn JSON: {"prompts": ["…", …]} — exactly ${input.beats.length} strings, in beat order.`;
    const result = await this.chatJson<{ prompts?: unknown }>(user, {
      temperature: 0.4,
      // Each prompt now LEADS with a full state clause (place+in/out, time, weather,
      // outfit) before the scene, so it's longer — budget ~160 tok/beat or a
      // truncated tail silently falls back to base prompts (the flicker returns).
      maxTokens: Math.max(8000, input.beats.length * 160 + 3000),
      // Background render job (not interactive) — allow generously for many beats.
      timeoutMs: 45000,
    });
    const prompts = asArray<unknown>(result.prompts).map((p) => String(p ?? "").trim());
    // Align 1:1 to beats; fall back to the beat's base prompt (or its line) on any gap.
    return input.beats.map((b, i) => prompts[i] || b.imagePrompt?.trim() || b.text.trim());
  }

  async expandImagePrompts(input: ExpandImagePromptsInput): Promise<string[][]> {
    if (input.beats.length === 0) return [];
    // BATCHED: one call for all ~132 long-form shots is slow (~3s/shot) and would
    // blow the timeout → the caller would fall back to the base prompt for all 3
    // shots (the exact duplication we're avoiding). So split into small batches,
    // run a few at a time, and let a failed batch degrade ONLY its own beats
    // (placeholder entries keep every beat's index aligned for the pad/trim).
    const BATCH = 6;
    const CONCURRENCY = 4;
    const batches: ExpandImagePromptsInput["beats"][] = [];
    for (let i = 0; i < input.beats.length; i += BATCH) batches.push(input.beats.slice(i, i + BATCH));

    const results: Array<{ prompts?: unknown }>[] = new Array(batches.length);
    let next = 0;
    const runOne = async (): Promise<void> => {
      for (;;) {
        const idx = next++;
        if (idx >= batches.length) return;
        const batch = batches[idx]!;
        try {
          const totalFrames = batch.reduce((n, b) => n + b.count, 0);
          const user = `${buildExpandFramesInstruction({ setting: input.setting, style: input.style, beats: batch })}\n\nReturn JSON: {"beats": [{"prompts": ["…", …]}, …]} — one entry per beat, in beat order, each with exactly its requested number of prompts.`;
          const result = await this.chatJson<{ beats?: Array<{ prompts?: unknown }> }>(user, {
            temperature: 0.5,
            // Floor 8000: V4 is a REASONING model — a tight cap gets spent thinking
            // and returns EMPTY content (which would fall back to base prompts and
            // read as duplicates). Same floor the single-call version used.
            maxTokens: Math.max(8000, totalFrames * 150 + 3000),
            timeoutMs: 75000,
          });
          const raw = asArray<{ prompts?: unknown }>(result.beats);
          // Always contribute exactly batch.length entries so later batches stay
          // index-aligned; a missing/short answer degrades only its own beats.
          results[idx] = batch.map((_, j) => raw[j] ?? {});
        } catch {
          // Degrade just this batch: empty entries → pad/trim falls back to each
          // beat's base prompt (only these beats repeat, never the whole video).
          results[idx] = batch.map(() => ({}));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runOne));

    // Shared pad/trim so the slide list never desyncs from the timing plan.
    return alignExpandedFrames(input, results.flat());
  }
}
