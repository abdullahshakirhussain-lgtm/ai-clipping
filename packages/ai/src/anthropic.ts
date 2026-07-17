import Anthropic from "@anthropic-ai/sdk";
import type {
  ClipSignals,
  CommentaryIntensity,
  CommentaryLine,
  CommentaryRole,
  DetectHighlightsInput,
  EnhanceClipInput,
  EnhancementResult,
  HighlightCandidate,
  HookType,
  LlmProvider,
  PlanCommentaryInput,
  PlanEnhancementsInput,
  RefineHighlightsInput,
  SfxCue,
  SfxSound,
  TranscriptSegment,
} from "./types.js";

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(n) || lo));

const HOOK_TYPES: HookType[] = [
  "question",
  "bold_claim",
  "curiosity_gap",
  "number_list",
  "controversy",
  "cliffhanger",
  "story",
  "none",
];

interface RawClip {
  startSec: number;
  endSec: number;
  hook?: string;
  reason?: string;
  topic?: string;
  hookType?: string;
  hookStrength?: number;
  frontLoading?: number;
  selfContained?: number;
  emotion?: number;
  loopability?: number;
}

/** Split segments into windows of ~chunkSec so long videos aren't crammed into one call. */
function chunkSegments(segments: TranscriptSegment[], chunkSec: number): TranscriptSegment[][] {
  if (segments.length === 0) return [];
  const chunks: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let windowStart = segments[0]!.start;
  for (const seg of segments) {
    if (seg.start - windowStart >= chunkSec && current.length > 0) {
      chunks.push(current);
      current = [];
      windowStart = seg.start;
    }
    current.push(seg);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Claude-backed highlight detection, metadata generation, and scoring signals.
 *
 * Detection is chunked across long transcripts and asks for *all* strong moments
 * in each window (no fixed count), each annotated with sub-signals the scoring
 * model in packages/core turns into an explainable hook/viral score. Uses forced
 * tool-calling so output is structured, not fragile prose.
 */
export class AnthropicLlmProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-5";
  }

  /** Force a single tool call and return its (already-parsed) input object. */
  private async callTool<T>(prompt: string, tool: Anthropic.Tool, maxTokens = 4096): Promise<T> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
    });
    const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!block) throw new Error("Claude did not return the expected tool call");
    return block.input as T;
  }

  async detectHighlights(input: DetectHighlightsInput): Promise<HighlightCandidate[]> {
    const chunkSec = Math.max(60, input.chunkMinutes * 60);
    const chunks = chunkSegments(input.segments, chunkSec);
    const all: HighlightCandidate[] = [];
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const cands = await this.detectChunk(chunk, input);
      all.push(...cands);
    }
    return all;
  }

  private async detectChunk(
    chunk: TranscriptSegment[],
    input: DetectHighlightsInput,
  ): Promise<HighlightCandidate[]> {
    const chunkStart = chunk[0]!.start;
    const chunkEnd = chunk[chunk.length - 1]!.end;
    const transcript = chunk
      .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
      .join("\n");
    const peaksInChunk = (input.audioPeaks ?? []).filter((p) => p >= chunkStart && p <= chunkEnd);
    const peakHint = peaksInChunk.length
      ? `\nHigh audio-energy moments (laughs/reactions/action) were detected near these timestamps — consider clips around them even if the words are ordinary: ${peaksInChunk.map((p) => p.toFixed(0) + "s").join(", ")}.`
      : "";

    const result = await this.callTool<{ clips?: RawClip[] }>(
      `You are a short-form video editor who finds every viral-worthy moment in long-form content.

Transcript window with timestamps:
${transcript}
${peakHint}

Return ALL self-contained moments worth clipping for vertical short-form (TikTok/Reels/Shorts) — could be a few or many, however many are genuinely good. Do not pad with weak ones.
Each clip must be ${input.minDurationSec}-${input.maxDurationSec} seconds, start/end on natural sentence boundaries, and make sense with zero context.
For each clip also rate the sub-signals honestly (0-100) so it can be scored. Call submit_highlights.`,
      {
        name: "submit_highlights",
        description: "Submit the selected highlight clips with scoring signals.",
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
                  hookType: {
                    type: "string",
                    enum: HOOK_TYPES,
                    description: "shape of the opening hook",
                  },
                  hookStrength: { type: "number", description: "0-100 strength of the opening line" },
                  frontLoading: { type: "number", description: "0-100 payoff in the first ~3s" },
                  selfContained: { type: "number", description: "0-100 makes sense with zero context and resolves" },
                  emotion: { type: "number", description: "0-100 funny/shocking/insightful/satisfying intensity" },
                  loopability: { type: "number", description: "0-100 rewatch/replay/stitch potential" },
                },
                required: [
                  "startSec",
                  "endSec",
                  "hook",
                  "reason",
                  "topic",
                  "hookType",
                  "hookStrength",
                  "frontLoading",
                  "selfContained",
                  "emotion",
                  "loopability",
                ],
              },
            },
          },
          required: ["clips"],
        },
      },
    );

    return (result.clips ?? [])
      .filter((c) => Number.isFinite(c.startSec) && Number.isFinite(c.endSec) && c.endSec > c.startSec)
      .map((c) => {
        const startSec = clamp(c.startSec, 0, input.durationSec);
        let endSec = clamp(c.endSec, 0, input.durationSec);
        // Enforce max duration; drop below-min happens after scoring in core.
        if (endSec - startSec > input.maxDurationSec) endSec = startSec + input.maxDurationSec;
        const signals: ClipSignals = {
          hookType: HOOK_TYPES.includes(c.hookType as HookType) ? (c.hookType as HookType) : "none",
          hookStrength: clamp(c.hookStrength ?? 50, 0, 100),
          frontLoading: clamp(c.frontLoading ?? 50, 0, 100),
          selfContained: clamp(c.selfContained ?? 50, 0, 100),
          emotion: clamp(c.emotion ?? 50, 0, 100),
          loopability: clamp(c.loopability ?? 50, 0, 100),
        };
        return {
          startSec,
          endSec,
          hook: String(c.hook ?? "").slice(0, 200),
          reason: String(c.reason ?? ""),
          topic: String(c.topic ?? "general"),
          source: "transcript" as const,
          signals,
        };
      })
      .filter((c) => c.endSec > c.startSec);
  }

  async refineHighlights(input: RefineHighlightsInput): Promise<number[]> {
    if (input.clips.length === 0) return [];
    const list = input.clips
      .map(
        (c) =>
          `#${c.index} (${c.durationSec.toFixed(0)}s) hook: "${c.hook}"\n  transcript: ${c.transcript.slice(0, 400)}`,
      )
      .join("\n\n");

    const result = await this.callTool<{ keep?: number[] }>(
      `You are a ruthless short-form video editor doing a final quality gate.
For each candidate clip below, keep it ONLY if it: (a) makes complete sense with zero context, (b) actually pays off / resolves (not just a setup), and (c) has a genuine scroll-stopping hook. Cut anything mediocre — it's better to ship fewer great clips.

Candidates:
${list}

Call submit_review with the indices to KEEP.`,
      {
        name: "submit_review",
        description: "Submit the indices of clips worth keeping.",
        input_schema: {
          type: "object",
          properties: {
            keep: { type: "array", items: { type: "number" }, description: "indices to keep" },
          },
          required: ["keep"],
        },
      },
      1024,
    );
    return (result.keep ?? []).map(Number).filter((n) => Number.isInteger(n));
  }

  async planEnhancements(input: PlanEnhancementsInput): Promise<SfxCue[]> {
    const valid: SfxSound[] = ["whoosh", "boom", "faaaaa"];
    const result = await this.callTool<{ cues?: Array<{ atSec?: number; sound?: string; reason?: string }> }>(
      `You add sound effects to a short-form clip — with EXTREME restraint. Over-used SFX ruin a video; most clips deserve ZERO. Only place a cue where it genuinely lands.

Transcript (times in seconds within this ${input.durationSec.toFixed(0)}s clip):
${input.transcript}

Sounds:
- "faaaaa": ONLY for a genuinely absurd, dumb, or wild statement — the "did he really just say that" moment. This is the point of the whole thing; use it when someone says something stupid/ridiculous, and essentially never otherwise.
- "boom": a hard punchline or big impact landing. Rare.
- "whoosh": a quick reveal/transition. Rare.

Rules: at most ${input.maxCues} cues total; most clips should get 0-1; never cluster them; place atSec on the exact moment. If nothing truly warrants a sound, return an empty list. Call submit_cues.`,
      {
        name: "submit_cues",
        description: "Submit sparse sound-effect cues (empty if none warranted).",
        input_schema: {
          type: "object",
          properties: {
            cues: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  atSec: { type: "number", description: "seconds into the clip" },
                  sound: { type: "string", enum: valid },
                  reason: { type: "string", description: "why this exact moment" },
                },
                required: ["atSec", "sound", "reason"],
              },
            },
          },
          required: ["cues"],
        },
      },
      1024,
    );

    return (result.cues ?? [])
      .filter((c) => Number.isFinite(c.atSec) && valid.includes(c.sound as SfxSound))
      .map((c) => ({
        atSec: clamp(c.atSec!, 0, input.durationSec),
        sound: c.sound as SfxSound,
        reason: String(c.reason ?? ""),
      }));
  }

  async planCommentary(input: PlanCommentaryInput): Promise<CommentaryLine[]> {
    const allowed: CommentaryRole[] =
      input.mode === "intro_outro"
        ? ["intro", "outro"]
        : input.mode === "interject"
          ? ["react"]
          : ["intro", "react", "outro"];
    const structure =
      input.mode === "intro_outro"
        ? "Exactly one intro and one outro. No reacts."
        : input.mode === "interject"
          ? "ONE react — the single best moment. A second only if the clip truly has two separate moments worth stopping for."
          : "Exactly one intro, ONE react (the single best moment), and one outro. Four lines is already a lot.";

    const persona =
      input.persona?.trim() ||
      "The friend on the couch who can't help talking back at the screen — quick, sarcastic, zero reverence, but sharp enough that the mockery is earned.";

    const result = await this.callTool<{
      lines?: Array<{ atSec?: number; text?: string; role?: string; delivery?: string; intensity?: string }>;
    }>(
      `You are the commentator on a short-form clip. The video FREEZES, you speak, then it resumes — so every line has to earn the interruption.

WHO YOU ARE: ${persona}

Transcript (times in seconds within this ${input.durationSec.toFixed(0)}s clip):
${input.transcript}${input.category ? `\n\nChannel niche: ${input.category}` : ""}

Your job is to have an OPINION — and opinions have teeth. Find the dumbest thing in this clip and go after it; don't be polite about it. Where they're actually right, push back on the part everyone else would let slide. Mild profanity ("hell", "damn", "BS") is allowed when it lands — never forced, never stronger than that. What you may NOT do is hedge: no "to be fair", no "that said", no "in a way", no both-sides. Pick a side and commit.

THE TEST EVERY LINE MUST PASS: could this line be pasted onto a different video? If yes, it is filler — cut it. Anchor to something SPECIFIC in this clip: the number they said, the exact claim, the word they chose.

Filler — never write anything like this:
- "This is actually insane."
- "Wait till you see what happens next."
- "That's a bold strategy."
- "And that's where it falls apart."
These say nothing. They'd fit any clip ever made. Polite observations are filler too.

Real commentary — only possible having heard THIS clip, and with a spine:
- "Five Lamborghinis, and he's stressed... about the jelly."
- "He said guaranteed. TWICE. Nothing here is guaranteed."
- "Third rule he's invented in ten seconds. Just making it up now."

Every interruption freezes the video and spends the viewer's patience. If a moment doesn't clearly earn a full stop, leave it alone — fewer, better lines beat full coverage. Returning fewer lines than the structure allows is a valid answer.

Structure: ${structure}
- intro: atSec 0. Why this clip is worth the next 30 seconds.
- react: atSec = the exact moment you're reacting to.
- outro: atSec ${input.durationSec.toFixed(0)}. Your verdict.

This is spoken aloud by a voice that performs EXACTLY what you write — text, punctuation, and your stage direction. Write the performance, not just the words:
- CAPS on a word means it gets SHOUTED. Use it where a person would actually raise their voice.
- "..." is a held beat. Stretch spellings when a human would ("riiiight", "nooo").
- Contractions. Vary sentence length. Fragments are fine.
- Max ~12 words a line. Shorter hits harder.
- One idea per line. No lists, no "first/second/finally" cadence.
- Punctuate for BREATH, not for grammar — commas and "..." where a person would actually hesitate, a beat before the punch.
- Banned openers/phrases: "In this video", "Let's dive in", "Here's the thing", "buckle up", "little did they know", "you won't believe".
- No throat-clearing, no summarising, no explaining the joke.

For EACH line, also direct the voice actor:
- "delivery": 1-2 sentences on HOW to say this exact line — pace, pitch moves, where it breaks into a laugh or drops to contempt. Every line should read differently; a mocking imitation, a slow disgusted drawl, and a disbelieving shout are three different performances. Never reuse a direction.
- "intensity": "loud" if the line is raised/shouted, "quiet" if it's a low deadpan or muttered aside, "normal" otherwise. Vary it — all-normal means you wrote it flat.

Call submit_lines.`,
      {
        name: "submit_lines",
        description: "Submit the spoken commentary lines for this clip.",
        input_schema: {
          type: "object",
          properties: {
            lines: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  atSec: { type: "number", description: "seconds into the clip" },
                  text: { type: "string", description: "the spoken line, ~12 words max" },
                  role: { type: "string", enum: allowed },
                  delivery: {
                    type: "string",
                    description: "voice-actor direction for this exact line: pace, pitch, attitude",
                  },
                  intensity: { type: "string", enum: ["quiet", "normal", "loud"] },
                },
                required: ["atSec", "text", "role", "delivery", "intensity"],
              },
            },
          },
          required: ["lines"],
        },
      },
      1536,
    );

    const intensities: CommentaryIntensity[] = ["quiet", "normal", "loud"];
    return (result.lines ?? [])
      .filter(
        (l) =>
          Number.isFinite(l.atSec) &&
          String(l.text ?? "").trim().length > 0 &&
          allowed.includes(l.role as CommentaryRole),
      )
      .map((l) => ({
        atSec: clamp(l.atSec!, 0, input.durationSec),
        text: String(l.text).trim(),
        role: l.role as CommentaryRole,
        ...(String(l.delivery ?? "").trim() ? { delivery: String(l.delivery).trim() } : {}),
        ...(intensities.includes(l.intensity as CommentaryIntensity)
          ? { intensity: l.intensity as CommentaryIntensity }
          : {}),
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
          },
          required: ["title", "description", "hashtags", "hookVariants"],
        },
      },
      1024,
    );

    return {
      title: String(p.title ?? input.hook).slice(0, 120),
      description: String(p.description ?? ""),
      hashtags: (p.hashtags ?? []).map(String).slice(0, 6),
      hookVariants: (p.hookVariants ?? [input.hook]).map(String).slice(0, 3),
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
