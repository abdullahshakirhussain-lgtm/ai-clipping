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

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(n) || lo));

/**
 * Claude-backed highlight detection, metadata generation, and scoring.
 *
 * Uses forced tool-calling instead of asking for JSON in prose: the model must
 * return a structured object matching the tool's input schema, so there's no
 * fragile parsing of free-form text (and no reliance on assistant prefill, which
 * newer models reject).
 */
export class AnthropicLlmProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-5";
  }

  /** Force a single tool call and return its (already-parsed) input object. */
  private async callTool<T>(prompt: string, tool: Anthropic.Tool, maxTokens = 2048): Promise<T> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
    });
    const block = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!block) throw new Error("Claude did not return the expected tool call");
    return block.input as T;
  }

  async detectHighlights(input: DetectHighlightsInput): Promise<HighlightCandidate[]> {
    const rules = (input.rules ?? {}) as { minDurationSec?: number; maxDurationSec?: number };
    const transcript = input.segments
      .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
      .join("\n");

    const result = await this.callTool<{ clips?: HighlightCandidate[] }>(
      `You are a short-form video editor who finds viral moments in long-form content.

Transcript with timestamps (video is ${input.durationSec.toFixed(0)}s long):
${transcript}

Find the ${input.maxCandidates ?? 4} best self-contained moments for vertical short-form clips.
Constraints: each clip ${rules.minDurationSec ?? 15}-${rules.maxDurationSec ?? 60} seconds; must start/end at natural sentence boundaries; must make sense with zero context.
Call submit_highlights with your picks.`,
      {
        name: "submit_highlights",
        description: "Submit the selected highlight clips.",
        input_schema: {
          type: "object",
          properties: {
            clips: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  startSec: { type: "number" },
                  endSec: { type: "number" },
                  hook: { type: "string", description: "scroll-stopping opening line" },
                  reason: { type: "string", description: "why this will perform" },
                  topic: { type: "string", description: "one-word topic" },
                },
                required: ["startSec", "endSec", "hook", "reason", "topic"],
              },
            },
          },
          required: ["clips"],
        },
      },
    );

    return (result.clips ?? [])
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
    const p = await this.callTool<Partial<EnhancementResult>>(
      `You optimize short-form clips for TikTok/Reels/Shorts. Target platforms: ${input.platformHints.join(", ")}.

Clip transcript (${input.durationSec.toFixed(0)}s${input.creatorName ? `, creator: ${input.creatorName}` : ""}):
"""${input.transcriptExcerpt}"""
Current hook: "${input.hook}"
Topic: ${input.topic}

Call submit_metadata with optimized fields.`,
      {
        name: "submit_metadata",
        description: "Submit optimized clip metadata.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "<=90 chars" },
            description: { type: "string", description: "2-3 sentences with a CTA" },
            hashtags: { type: "array", items: { type: "string" }, description: "max 6, with #" },
            hookVariants: { type: "array", items: { type: "string" }, description: "3 alternative hooks" },
            qualityScore: { type: "number", description: "0-100" },
            viralScore: { type: "number", description: "0-100" },
            estimatedEngagement: { type: "number", description: "0-10" },
          },
          required: ["title", "description", "hashtags", "hookVariants", "qualityScore", "viralScore", "estimatedEngagement"],
        },
      },
    );

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
    const result = await this.callTool<{ hooks?: string[] }>(
      `Rewrite this short-form video hook to be more scroll-stopping. Content: """${input.transcriptExcerpt.slice(0, 500)}"""
Current hook: "${input.currentHook}"
Call submit_hooks with 3 improved hooks.`,
      {
        name: "submit_hooks",
        description: "Submit improved hook variations.",
        input_schema: {
          type: "object",
          properties: {
            hooks: { type: "array", items: { type: "string" }, description: "3 improved hooks" },
          },
          required: ["hooks"],
        },
      },
      512,
    );
    return (result.hooks ?? []).map(String).slice(0, 3);
  }
}
