import Anthropic from "@anthropic-ai/sdk";
import type {
  DetectHighlightsInput,
  EnhanceClipInput,
  EnhancementResult,
  HighlightCandidate,
  LlmProvider,
} from "./types.js";

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
}

/** Extracts the first JSON array/object from an LLM reply, tolerating fences. */
function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]! : text;
  const start = Math.min(
    ...["[", "{"].map((c) => {
      const i = raw.indexOf(c);
      return i === -1 ? Number.POSITIVE_INFINITY : i;
    }),
  );
  if (!Number.isFinite(start)) throw new Error("No JSON found in LLM response");
  return JSON.parse(raw.slice(start)) as T;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(n) || lo));

/** Claude-backed highlight detection, metadata generation, and scoring. */
export class AnthropicLlmProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-5";
  }

  private async complete(prompt: string, maxTokens = 2048): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  async detectHighlights(input: DetectHighlightsInput): Promise<HighlightCandidate[]> {
    const rules = (input.rules ?? {}) as { minDurationSec?: number; maxDurationSec?: number };
    const transcript = input.segments
      .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
      .join("\n");
    const text = await this.complete(
      `You are a short-form video editor who finds viral moments in long-form content.

Transcript with timestamps (video is ${input.durationSec.toFixed(0)}s long):
${transcript}

Find the ${input.maxCandidates ?? 4} best self-contained moments for vertical short-form clips.
Constraints: each clip ${rules.minDurationSec ?? 15}-${rules.maxDurationSec ?? 60} seconds; must start/end at natural sentence boundaries; must make sense with zero context.

Reply with ONLY a JSON array:
[{"startSec": number, "endSec": number, "hook": "scroll-stopping opening line", "reason": "why this will perform", "topic": "one-word topic"}]`,
    );
    const parsed = extractJson<HighlightCandidate[]>(text);
    return parsed
      .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec)
      .map((c) => ({
        startSec: clamp(c.startSec, 0, input.durationSec),
        endSec: clamp(c.endSec, 0, input.durationSec),
        hook: String(c.hook ?? "").slice(0, 200),
        reason: String(c.reason ?? ""),
        topic: String(c.topic ?? "general"),
      }));
  }

  async enhanceClip(input: EnhanceClipInput): Promise<EnhancementResult> {
    const text = await this.complete(
      `You optimize short-form clips for TikTok/Reels/Shorts. Target platforms: ${input.platformHints.join(", ")}.

Clip transcript (${input.durationSec.toFixed(0)}s${input.creatorName ? `, creator: ${input.creatorName}` : ""}):
"""${input.transcriptExcerpt}"""
Current hook: "${input.hook}"
Topic: ${input.topic}

Reply with ONLY a JSON object:
{"title": "<=90 chars", "description": "2-3 sentences with a CTA", "hashtags": ["#tag", ...max 6], "hookVariants": ["3 alternative hooks"], "qualityScore": 0-100, "viralScore": 0-100, "estimatedEngagement": 0-10}`,
    );
    const p = extractJson<Partial<EnhancementResult>>(text);
    return {
      title: String(p.title ?? input.hook).slice(0, 120),
      description: String(p.description ?? ""),
      hashtags: (p.hashtags ?? []).map(String).slice(0, 6),
      hookVariants: (p.hookVariants ?? [input.hook]).map(String).slice(0, 3),
      qualityScore: clamp(p.qualityScore ?? 50, 0, 100),
      viralScore: clamp(p.viralScore ?? 50, 0, 100),
      estimatedEngagement: clamp(p.estimatedEngagement ?? 5, 0, 10),
      model: this.model,
    };
  }

  async improveHooks(input: { currentHook: string; transcriptExcerpt: string }): Promise<string[]> {
    const text = await this.complete(
      `Rewrite this short-form video hook to be more scroll-stopping. Content: """${input.transcriptExcerpt.slice(0, 500)}"""
Current hook: "${input.currentHook}"
Reply with ONLY a JSON array of 3 improved hook strings.`,
      512,
    );
    return extractJson<string[]>(text).map(String).slice(0, 3);
  }
}
