import { asArray, strList } from "./anthropic.js";
import { buildImagePromptsInstruction, buildTopicsInstruction } from "./story-prompts.js";
import type { CheapTextProvider, RefineImagePromptsInput, SuggestTopicsInput } from "./types.js";

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

  private async chatJson<T>(user: string, opts?: { temperature?: number; maxTokens?: number }): Promise<T> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: opts?.temperature ?? 0.7,
        // V4 models emit reasoning_content before the answer; a tight cap gets
        // spent thinking and returns empty content, so budget generously.
        max_tokens: opts?.maxTokens ?? 8000,
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content?.trim() || "{}";
    return JSON.parse(content) as T;
  }

  async suggestStoryTopics(input: SuggestTopicsInput): Promise<string[]> {
    const user = `${buildTopicsInstruction(input)}\n\nReturn JSON: {"topics": ["…", …]} — a flat array of strings.`;
    const result = await this.chatJson<{ topics?: unknown }>(user, { temperature: 1 });
    return strList(result.topics).map((s) => s.trim()).filter(Boolean).slice(0, input.count);
  }

  async refineImagePrompts(input: RefineImagePromptsInput): Promise<string[]> {
    if (input.beats.length === 0) return [];
    const user = `${buildImagePromptsInstruction(input)}\n\nReturn JSON: {"prompts": ["…", …]} — exactly ${input.beats.length} strings, in beat order.`;
    const result = await this.chatJson<{ prompts?: unknown }>(user, {
      temperature: 0.4,
      maxTokens: Math.max(8000, input.beats.length * 120 + 2000),
    });
    const prompts = asArray<unknown>(result.prompts).map((p) => String(p ?? "").trim());
    // Align 1:1 to beats; fall back to the beat's base prompt (or its line) on any gap.
    return input.beats.map((b, i) => prompts[i] || b.imagePrompt?.trim() || b.text.trim());
  }
}
