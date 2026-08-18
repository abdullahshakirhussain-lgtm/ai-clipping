import Anthropic from "@anthropic-ai/sdk";
import { resolveVoice, voiceCatalogue } from "./call-brief.js";
import { alignExpandedFrames, buildExpandFramesInstruction, buildImagePromptsInstruction, buildTopicsInstruction } from "./story-prompts.js";
import { planVisionBatches } from "./types.js";
import type {
  AnimShot,
  CallCharacter,
  CallPlan,
  ClipSignals,
  PlanAnimationInput,
  CommentaryIntensity,
  CommentaryLine,
  CommentaryRole,
  CookPlan,
  DescribeVideoContextInput,
  DetectHighlightsInput,
  ExpandImagePromptsInput,
  PlanCallInput,
  PlanCookInput,
  PlanPovInput,
  PovPlan,
  StoryScript,
  SuggestTopicsInput,
  WriteStoryInput,
  EnhanceClipInput,
  EnhancementResult,
  HighlightCandidate,
  HookType,
  LlmProvider,
  PlanCommentaryInput,
  PlanEnhancementsInput,
  RefineHighlightsInput,
  RefineImagePromptsInput,
  SfxCue,
  SfxSound,
  TranscriptSegment,
} from "./types.js";

export interface AnthropicLlmOptions {
  apiKey: string;
  model?: string;
  /** Model for commentary writing only (defaults to `model`). Opus is wittier. */
  commentaryModel?: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(n) || lo));

/**
 * Tool schemas are hints, not guarantees (no `strict: true`), so the model
 * sometimes returns an array field as a single value — e.g. `hashtags` as the
 * string "#history #victorian". `?? []` doesn't catch a truthy non-array, so
 * `.map` then throws. These coerce defensively: `asArray` for structured lists
 * (beats, spine, characters), `strList` for string lists that may arrive as a
 * delimited string (hashtags, hooks, topics).
 */
export const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
export const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : typeof v === "string"
      ? v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      : [];

/**
 * Hashtags, normalized: each gets exactly ONE leading '#', spaces removed, empties
 * dropped, deduped (case-insensitive), capped. The model is told to include the '#'
 * but sometimes returns a bare word — which then shows in the caption as plain text
 * with no '#'. Forcing it here fixes it everywhere hashtags are stored/used.
 */
export const hashList = (v: unknown, max = 6): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of strList(v)) {
    const tag = "#" + raw.replace(/^#+/, "").replace(/\s+/g, "");
    if (tag.length <= 1) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
};

/** Words → a human runtime, in minutes once "seconds" stops being readable. */
function describeLength(words: number): string {
  const sec = Math.round(words / 2.5);
  return sec < 120 ? `${sec} seconds` : `${(sec / 60).toFixed(1)} minutes`;
}

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
  private readonly commentaryModel: string;

  constructor(opts: AnthropicLlmOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-5";
    this.commentaryModel = opts.commentaryModel ?? this.model;
  }

  /** Force a single tool call and return its (already-parsed) input object. */
  private async callTool<T>(
    prompt: string | Anthropic.ContentBlockParam[],
    tool: Anthropic.Tool,
    maxTokens = 4096,
    opts?: { model?: string; temperature?: number; effort?: "low" | "medium" | "high" | "xhigh" | "max" },
  ): Promise<T> {
    const model = opts?.model ?? this.model;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const pickToolUse = (msg: Anthropic.Message): T | null => {
      const b = msg.content.find((x): x is Anthropic.ToolUseBlock => x.type === "tool_use");
      return b ? (b.input as T) : null;
    };

    // Reasoning path: adaptive thinking + effort lets the model plan the story
    // (angle selection, arc, topic-faithfulness) BEFORE writing — the biggest
    // quality lever for the writers.
    //
    // We FORCE the tool here (tool_choice: "tool"), not "auto". The old code used
    // "auto" on the belief that forced tool_choice is incompatible with thinking
    // — true for legacy budget_tokens thinking, but NOT for adaptive thinking on
    // the first-party API (only Bedrock still requires thinking disabled with a
    // forced tool). Under "auto" the model routinely thought and then answered in
    // prose WITHOUT emitting the tool_use block, so the reasoning pass silently
    // fell through to the dumb forced-tool call below on most stories — that was
    // the "reasoning call returned no tool_use" log, and the real quality ceiling.
    // Forcing the tool while thinking gives reasoning AND a guaranteed structured
    // result in one call. If a model/account rejects the combo (e.g. Bedrock), we
    // still degrade to the plain forced-tool call below.
    if (opts?.effort) {
      try {
        const out = pickToolUse(
          await this.client.messages.create({
            model,
            max_tokens: maxTokens,
            thinking: { type: "adaptive" },
            output_config: { effort: opts.effort },
            tools: [tool],
            tool_choice: { type: "tool", name: tool.name },
            messages,
          }),
        );
        if (out) return out;
        // Forced tool_choice should always yield a tool_use; a miss means an empty
        // completion (e.g. hit max_tokens mid-think). Fall through to retry plain.
        console.warn(`[story] forced-tool reasoning call returned no tool_use (effort=${opts.effort}); retrying without thinking`);
      } catch (err) {
        // The thinking + forced-tool combo isn't accepted here (Bedrock, or an
        // account/model that rejects it) — degrade to the plain call, but surface
        // it: a silent fallback would hide that reasoning never engaged.
        console.warn(`[story] reasoning params rejected (effort=${opts.effort}): ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
      }
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages,
    };
    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create(params);
    } catch (err) {
      // Newer models reject `temperature` ("temperature is deprecated for this
      // model"); drop it and retry once so one param doesn't sink the call.
      if (params.temperature !== undefined && /temperature/i.test(err instanceof Error ? err.message : String(err))) {
        const { temperature: _omit, ...rest } = params;
        msg = await this.client.messages.create(rest);
      } else {
        throw err;
      }
    }
    const out = pickToolUse(msg);
    if (!out) throw new Error("Claude did not return the expected tool call");
    return out;
  }

  /**
   * Commentary tool call on the (possibly premium) commentary model, with an
   * automatic fall back to the base model if that call fails — so switching
   * COMMENTARY_MODEL to something the account can't reach degrades to Sonnet
   * commentary instead of silently killing the feature (it's best-effort
   * upstream, so an unhandled throw = no voice-over at all).
   */
  private async commentaryCall<T>(
    prompt: string,
    tool: Anthropic.Tool,
    maxTokens: number,
    temperature: number,
  ): Promise<T> {
    try {
      return await this.callTool<T>(prompt, tool, maxTokens, { model: this.commentaryModel, temperature });
    } catch (err) {
      if (this.commentaryModel === this.model) throw err;
      return await this.callTool<T>(prompt, tool, maxTokens, { model: this.model, temperature });
    }
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
    return asArray<unknown>(result.keep).map(Number).filter((n) => Number.isInteger(n));
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

  /**
   * Two-pass so the take is creative AND disciplined (mirrors detect→refine):
   *   Pass 1 brainstorms many angled candidate lines hot (temp 1.0);
   *   Pass 2 coldly (temp 0.4) keeps only the sharpest 1-3, drops narration/
   *   spoilers/repeats, and finalizes delivery + intensity.
   * Both run on the commentary model (Opus by default). Anti-spoiler rules are
   * in both prompts: a line may only reference what a first-time viewer has
   * already heard by its atSec.
   */
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
          : "One intro, ONE react (the single best moment), and one outro. Fewer is fine.";

    const persona =
      input.persona?.trim() ||
      "The friend on the couch who can't help talking back at the screen — quick, sarcastic, zero reverence, but sharp enough that the mockery is earned.";

    const contextBlock = input.context
      ? `\n\nWHAT YOU KNOW ABOUT THIS VIDEO (from the uploader and on-screen text — use these names and facts freely, they're verified):\n${input.context}`
      : "";

    const antiSpoiler = `TIMING (critical): each line is spoken while the video is PAUSED at its atSec, so a line may only reference what a first-time viewer has ALREADY HEARD by that point.
- intro (atSec 0): the viewer has seen NOTHING yet. Tease why it's worth watching — never reveal the payoff or the ending.
- react: set atSec to JUST AFTER the line you're reacting to finishes — never at or before it, or you talk over the moment and spoil it.
- outro (atSec ${input.durationSec.toFixed(0)}): the clip is over; now you can judge the whole thing.`;

    // ── Pass 1: brainstorm many angles, hot. ──────────────────────────────────
    const brainstorm = await this.commentaryCall<{
      candidates?: Array<{ atSec?: number; role?: string; text?: string; angle?: string }>;
    }>(
      `You are the commentator on a short-form clip. The video FREEZES, you speak, then resumes. Brainstorm the raw material for a great take — quantity now, we cut later.

WHO YOU ARE: ${persona}

Transcript (times in seconds within this ${input.durationSec.toFixed(0)}s clip):
${input.transcript}${input.category ? `\n\nChannel niche: ${input.category}` : ""}${contextBlock}

THE ONE RULE: you add what the audio does NOT contain. The subtext. The contradiction. The context the viewer lacks. What everyone's thinking but nobody says. Where this is obviously headed. If a line just restates what's said or describes what's on screen, it is WORTHLESS — the viewer already heard it.

So for each candidate, commit to an ANGLE:
- contradiction — they just contradicted themselves; name it.
- hypocrisy — the thing they'd never accept from someone else.
- subtext — what they actually mean under the words.
- the-unsaid — the obvious point they're carefully avoiding.
- prediction — where this is heading, said before it lands.
- callback — tie this to something specific from earlier in the clip.
- absurdity — the detail that makes the whole thing ridiculous.

Have a spine — opinions have teeth. Go after the dumbest thing; don't be polite. Push back where they're wrong. Mild profanity ("hell", "damn", "BS") when it lands, never forced, never stronger. NO hedging ("to be fair", "that said", "in a way", both-sides).

${antiSpoiler}

Give me 6-8 candidates across the clip, each ≤ ~12 words, anchored to something SPECIFIC (the number, the exact claim, the word chosen) — nothing that could be pasted onto a different video. Roles allowed: ${allowed.join(", ")}. Call submit_candidates.`,
      {
        name: "submit_candidates",
        description: "Submit many candidate commentary lines to choose from later.",
        input_schema: {
          type: "object",
          properties: {
            candidates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  atSec: { type: "number", description: "seconds into the clip" },
                  role: { type: "string", enum: allowed },
                  text: { type: "string", description: "the candidate line, ~12 words max" },
                  angle: { type: "string", description: "which angle this line takes" },
                },
                required: ["atSec", "role", "text", "angle"],
              },
            },
          },
          required: ["candidates"],
        },
      },
      1536,
      1,
    );

    const candidates = (brainstorm.candidates ?? []).filter(
      (c) => Number.isFinite(c.atSec) && String(c.text ?? "").trim() && allowed.includes(c.role as CommentaryRole),
    );
    if (candidates.length === 0) return [];

    // ── Pass 2: select the sharpest, finalize performance, cold. ──────────────
    const candidateList = candidates
      .map((c, i) => `${i + 1}. [${c.role} @ ${Number(c.atSec).toFixed(1)}s | ${c.angle ?? "?"}] ${c.text}`)
      .join("\n");

    const result = await this.commentaryCall<{
      lines?: Array<{ atSec?: number; text?: string; role?: string; delivery?: string; intensity?: string }>;
    }>(
      `You are the editor choosing the final commentary for this ${input.durationSec.toFixed(0)}s clip. Here are the writer's candidates:

${candidateList}

Pick the SHARPEST few and throw out the rest. Ruthless bar:
- Cut anything that narrates or describes what the viewer can already see/hear.
- Cut anything that could be pasted onto another video (generic).
- Cut repeats of the same angle — variety beats coverage.
- A react must clearly EARN a full pause; if in doubt, drop it.
- Returning fewer lines than allowed is the RIGHT answer more often than not.

Structure to fill (do not pad to it): ${structure}

${antiSpoiler}

You may lightly rewrite a chosen line for punch, but keep its meaning and its atSec. Then perform it — this is read aloud by a voice that follows your text and punctuation EXACTLY:
- CAPS = shouted word. "..." = held beat. Stretch spellings a human would ("riiiight").
- Contractions, varied length, fragments. ≤ ~12 words. One idea per line.
- Punctuate for BREATH, not grammar — a beat before the punch.
- No throat-clearing, no summarising, no explaining the joke.
${
  input.voiceTags
    ? `- Place AUDIO TAGS inline where the performance shifts (acted, not spoken): [shouts], [laughs], [scoffs], [whispers], [sighs], [sarcastic], [pause]. 1-3 per line, at the exact word. e.g. "[scoffs] Five Lamborghinis... [shouting] AND HE'S STRESSED ABOUT THE JELLY."\n`
    : ""
}
For EACH final line also give:
- "delivery": 1-2 sentences on HOW to say THIS line — pace, pitch, where it breaks into a laugh or drops to contempt. Never reuse a direction across lines.
- "intensity": "loud" (raised/shouted), "quiet" (low deadpan/muttered), or "normal". Vary it.

Call submit_lines.`,
      {
        name: "submit_lines",
        description: "Submit the final chosen commentary lines, performed.",
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
      0.4,
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

  /**
   * Who/what is this video about? Reads ON-SCREEN TEXT from frames sampled
   * across the timeline — captions, watermarks, usernames, title cards — plus
   * the title/filename and a transcript sample. Batched (3 frames per call,
   * stride-interleaved so every batch spans the whole video) with EARLY STOP:
   * a confident answer after batch 1 means the remaining frames are never sent.
   * Identity comes from written text and context only, never face recognition.
   */
  async describeVideoContext(input: DescribeVideoContextInput): Promise<string> {
    const batches = planVisionBatches(input.frames, 3).slice(0, 4);
    let notes = "";
    let context = "";
    for (const [i, batch] of batches.entries()) {
      const prompt = `These are ${batch.length} frames sampled from across one video (not consecutive).

Read ALL on-screen text: captions, subtitles, watermarks, usernames, channel names, title cards, chat overlays, lower thirds. Describe the setting and what is happening.

Video title/filename: ${input.title || "(none)"}
Transcript sample: """${input.transcriptSample.slice(0, 800)}"""${notes ? `\n\nNotes from earlier frames of this same video:\n${notes}` : ""}

Say who is speaking and what the video is about ONLY as far as the text, title, or transcript states it — never guess a name from a face. If you can't tell who it is, describe what you CAN see. 2-4 sentences.

Set confident=true ONLY if you now know who/what this video is about well enough that more frames wouldn't change your answer. Call submit_context.`;

      const content: Anthropic.ContentBlockParam[] = [
        ...batch.map(
          (f): Anthropic.ContentBlockParam => ({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: f.toString("base64") },
          }),
        ),
        { type: "text", text: prompt },
      ];
      const result = await this.callTool<{ context?: string; confident?: boolean }>(
        content,
        {
          name: "submit_context",
          description: "Submit what this video is about, based on visible text and context.",
          input_schema: {
            type: "object",
            properties: {
              context: { type: "string", description: "2-4 sentences: who/what this video is about" },
              confident: {
                type: "boolean",
                description: "true only if more frames would not change the answer",
              },
            },
            required: ["context", "confident"],
          },
        },
        768,
      );
      context = String(result.context ?? "").trim();
      if (result.confident === true || i === batches.length - 1) break;
      notes = context; // carry findings forward as text; images are never re-sent
    }
    return context;
  }

  async enhanceClip(input: EnhanceClipInput): Promise<EnhancementResult> {
    const p = await this.callTool<Partial<EnhancementResult>>(
      `You optimize short-form clips for TikTok/Reels/Shorts. Target platforms: ${input.platformHints.join(", ")}.

Clip transcript (${input.durationSec.toFixed(0)}s${input.creatorName ? `, creator: ${input.creatorName}` : ""}):
"""${input.transcriptExcerpt}"""
Current hook: "${input.hook}"
Topic: ${input.topic}${input.context ? `\nAbout this video (verified — use names in titles/hashtags): ${input.context}` : ""}

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
      hashtags: hashList(p.hashtags),
      hookVariants: (strList(p.hookVariants).length ? strList(p.hookVariants) : [input.hook]).slice(0, 3),
      model: this.model,
    };
  }

  async suggestStoryTopics(input: SuggestTopicsInput): Promise<string[]> {
    // Prompt is shared with the DeepSeek path (story-prompts.ts) so the two never
    // drift; this is the Anthropic/fallback route when no cheap model is set.
    const result = await this.callTool<{ topics?: string[] }>(
      `${buildTopicsInstruction(input)}\n\nCall submit_topics.`,
      {
        name: "submit_topics",
        description: "Submit candidate scenario ideas.",
        input_schema: {
          type: "object",
          properties: { topics: { type: "array", items: { type: "string" } } },
          required: ["topics"],
        },
      },
      1024,
      { temperature: 1 },
    );
    return strList(result.topics).map((s) => s.trim()).filter(Boolean).slice(0, input.count);
  }

  async refineImagePrompts(input: RefineImagePromptsInput): Promise<string[]> {
    if (input.beats.length === 0) return [];
    const result = await this.callTool<{ prompts?: string[] }>(
      `${buildImagePromptsInstruction(input)}\n\nCall submit_image_prompts with exactly ${input.beats.length} prompts, in beat order.`,
      {
        name: "submit_image_prompts",
        description: "Submit one tight image prompt per beat, in order.",
        input_schema: {
          type: "object",
          properties: { prompts: { type: "array", items: { type: "string" } } },
          required: ["prompts"],
        },
      },
      // ~120 tok/beat: each prompt now LEADS with a state clause (place+in/out,
      // time, weather, outfit) before the scene, so 60 would truncate the tail.
      Math.max(2048, input.beats.length * 120 + 1500),
      { model: this.model, effort: "low" },
    );
    const prompts = asArray<unknown>(result.prompts).map((p) => String(p ?? "").trim());
    return input.beats.map((b, i) => prompts[i] || b.imagePrompt?.trim() || b.text.trim());
  }

  async writeStory(input: WriteStoryInput): Promise<StoryScript> {
    // Ceiling 60: long-form is now ONE distinct illustration per beat (no more
    // splitting a beat into near-duplicate stills), so ~50 beats over ~8 minutes
    // is a new picture every ~10s. The old cap of 30 would have starved it.
    const maxBeats = Math.max(5, Math.min(60, input.maxBeats));
    // Ceiling is 1600 to allow long-form (~8 min at ~150 wpm ≈ 1200 words);
    // shorts pass a far lower maxWords and are unaffected.
    const maxWords = Math.max(120, Math.min(1600, input.maxWords));
    // Floors, kept strictly below the ceilings so the two can never invert.
    const minBeats = Math.max(5, Math.min(maxBeats, input.minBeats ?? 5));
    const minWords = Math.max(60, Math.min(maxWords - 10, input.minWords ?? 60));
    const narrator = input.narrator ?? "storyteller";
    const isScenario = (input.mode ?? "scenario") === "scenario";
    // HERO channel: a fixed NAMED man ("you, Kian, …") vs the stick channel's
    // name-less "you". Only affects the scenario opening/anchoring wording.
    const heroName = input.protagonistName?.trim();
    // Optional creator direction (what to mention/avoid, angle, tone). Honoured on
    // top of the doctrine but never overrides the hard rules (plain words, cold
    // open, no AI tells, etc.). Injected into both passes.
    const direction = input.direction?.trim();
    const directionBlock = direction
      ? `\n\nCREATOR'S DIRECTION FOR THIS VIDEO (follow it closely — it says what to include, what to leave out, and the angle/tone wanted; obey it as long as it doesn't break the hard rules above):\n"${direction}"\n`
      : "";
    // Long form (~8 min) vs a short. Use the EXPLICIT length signal when present
    // (no more guessing from word counts — that was the "vague path"); fall back to
    // maxWords only for old callers that don't pass length.
    const isLong = input.length ? input.length === "long" : maxWords >= 700;
    // How long each BEAT should be. Long form's image count is driven by the beat
    // COUNT (each beat splits into ≤3 stills), so it needs MANY beats, each a full
    // sentence — the earlier unconditional "short beats" made ~12 fat beats ⇒ 36
    // images. Shorts want many tiny one-image beats.
    const beatLengthGuidance = isLong
      ? `BEAT LENGTH IS CRITICAL — long form is ~8 minutes. Write ${minBeats}-${maxBeats} beats, and EACH beat is a FULL, unhurried sentence of roughly 22-28 words — about TEN seconds when spoken. This length is the whole game: a ten-second beat is shown as THREE successive pictures (≈3s cadence), while a clipped 5-10 word beat gets only ONE picture AND makes the video far too short. So do NOT write short fragments and do NOT rush the day — write complete, richly detailed sentences, ${minBeats}+ of them, until the narration reaches ${minWords}-${maxWords} words. ${minBeats} ten-second beats ≈ 8 minutes ≈ ~${minBeats * 3} pictures; that is the target.`
      : `Keep beats SHORT — one short sentence each (~3 seconds spoken). CRUCIAL LENGTH RULE: this is a SHORT and the whole narration MUST fit ${minWords}-${maxWords} words — a HARD ceiling (≈2.5 min, so it stays UNDER YouTube's 3-minute Shorts cap). You CANNOT narrate the whole day at this length, so do NOT try. Keep the WAKING open and the FALLING-ASLEEP close intact, but COMPRESS the middle HARD: pick only the 3-5 most striking moments of the day and jump straight from one to the next, like a highlight reel — never an hour-by-hour walk. Cutting the day down to fit the word ceiling is REQUIRED, not optional. Use only ${minBeats}-${maxBeats} beats.`;

    // Mode-specific instructions injected into the two shared prompts below. Both
    // modes keep the same craft (cold open, concrete named detail, chaining, no
    // cringe closer); they differ in SHAPE — a scenario is an immersive walk
    // through how something WAS (escalating "wait, really?" reveals, no dramatic
    // twist required), a story is one specific event with a hook and a turn.
    const architectRole = isScenario
      ? `You are the SCENARIO ARCHITECT for an immersive, second-person day-in-the-life explainer (TikTok/Reels/Shorts/YouTube). The subject is: "${input.topic}". Let the TOPIC decide the world and time — it may be historical, present-day, or timeless; do NOT force a past/period setting unless the topic itself is historical.`
      : `You are the STORY ARCHITECT for a short-form (TikTok/Reels/Shorts) story video. The topic is: "${input.topic}".`;
    const architectStep1 = isScenario
      ? `STEP 1 — FRAME ONE MAN'S PEACEFUL DAY, AND HOLD IT. "${input.topic}" is a window into a calm, good life — but "generic" is the enemy. Anchor the whole video to ONE SPECIFIC MAN the viewer BECOMES (never a woman or girl). ${heroName ? `The man is ${heroName} — the SAME man every video, just living a different life this time; use his name. This is a gentle, idyllic, contented day.` : `Pick a real or realistic man who fits the topic (its time, place and world, whatever that is) to keep the detail accurate — BUT the viewer never hears his name: do NOT open with or state "you are [Name], a [job]", and do NOT announce a name at all. The viewer is simply "you", a man.`} The viewer lives this one actual day in second person, start to finish — a PEACEFUL, contented GOOD day. List 3 such day ideas (one line each) in "angleOptions", then commit to ONE. THREE HARD RULES, because the usual failure is a script that sprawls:
   - ONE POINT OF VIEW, WHOLE VIDEO. The entire thing is lived from that one vantage in SECOND PERSON ("you"). NEVER cut away to "a real person did this" / "X testified that…" — that shatters the immersion. Concrete detail is WOVEN INTO the walk ("your neighbour the miller always waves you over for the first loaf")${heroName ? "" : " — you never leave the vantage point to cite anyone from outside, and you never name yourself"}.
   - ONE DAY, NOT A SURVEY. Follow a single representative DAY from waking to sleeping, and make it a GOOD, calm day (e.g. you wake up warm in bed → light the fire → walk through the village → do your day's work → eat supper with the family → go to bed and fall asleep). The day is the spine; walk it in order. Do NOT try to cover the whole topic — resist the pull to list every related person, place and event. Better to go deep on one peaceful lived day than wide across ten.
   - TIGHT CAST. Name at most ONE other real person, and only if the thread genuinely returns to them; everyone else is a role ("the miller", "your neighbour"), never a name met once and dropped.
The payoff is accumulated "so THAT's what a day was like" warmth — no dramatic twist required, but every beat must CAUSALLY follow the last (no swapping to an unrelated event). THE SHAPE IS ONE FULL DAY: your cold open is the MOMENT OF WAKING into this day (before dawn — a bird, a bell, first light through the shutters), and the video ends when the same man lies down to sleep that night, content. Make the hook a calm waking moment.`
      : `STEP 1 — BRAINSTORM 3 ANGLES, THEN PICK ONE. A topic is not a story. Think of 3 genuinely DIFFERENT true story angles, each unmistakably about "${input.topic}" (different people / events / moments). Judge them on: strongest hook, clearest arc, a real TURN (a reversal, a "wait, what?"), and how squarely on-topic they are. Then pick the SINGLE best — an angle with no real turn is disqualified. Where the story has a lead character, make it a MAN or boy. List the 3 one-line angle premises you weighed in "angleOptions".`;
    const architectEnding = isScenario
      ? `4. "ending": the END OF THE DAY — the man getting into bed that night, full and warm after a good day, and falling asleep. One plain detail, plain words. Not a moral, not a summary, not "and that's how it was". Never end on pain, cold, misery or dread.`
      : `4. "ending": the story's REAL final fact or consequence — the last thing that actually happened, stated as plain fact. It must resolve the question the cold open raised, but it is NOT a punchline: no moral, no call-to-action, no rhetorical question, no crafted closing line.`;
    const architectSpineRoles = isScenario
      ? `   - "role": its job — hook / reveal / escalate / turn-of-the-screw / close.`
      : `   - "role": its job in the arc — hook / rehook / setup / rising / turn / payoff.`;
    const narratorFraming = isScenario
      ? `You are the NARRATOR of an immersive second-person day-in-the-life explainer about "${input.topic}" (the topic sets the time and world — historical, present-day or timeless; don't force a past setting). Put the viewer INSIDE the scenario ("you") and walk them through it, each beat revealing another concrete, TRUE detail of how it actually is. It does not need a plot twist — escalating fascination is the engine. THREE RULES YOU MUST HOLD:
1. YOU ARE THE REAL PERSON FROM THE SPINE — stay in "you" EVERY beat. The vantage character is a specific, named, real (or real-detail representative) person, and the viewer IS them; live their actual experience. Never break out to cite them from the outside ("a real girl did this — Sarah, aged 8, told the Commission…"); if it's your own character, it's "you", and other real names/testimony get woven INTO your walk ("the inspector writing all this down would record that girls like you sang only when you had a light"). If a beat starts sounding like a documentary or a museum plaque, rewrite it back into "you".
2. ONE THREAD. Follow the single lived arc from the spine; do NOT wander off to survey every related person or event. Name at most one real person; everyone else is a role.
3. CAUSAL CHAIN. Every beat follows from the one before — never jump to an unrelated danger or fact (if a beat is about gas, the next isn't suddenly about a flood unless you connect them).`
      : `You are the NARRATOR. Turn this planned story about "${input.topic}" into finished spoken narration, beat by beat.`;
    // Scenario mode has no "final event", so the model reaches for a summary to
    // close — which is exactly the banned cringe closer. Tell it to stop on a
    // concrete sensory image instead. (A backstop; the pipeline also strips one.)
    const narratorEnding = isScenario
      ? `\n- SCENARIO ENDING: END THE DAY. The last beat is you getting into bed at night, full and warm after a good day, and falling asleep — do NOT wrap up, zoom out, or reflect. Say it in plain words ("You get into bed, warm and full, and you're asleep in a minute"). The pull to summarize ("and that was life in…", "it makes you wonder…") IS the banned closer. Never close on cold, pain, hunger or dread — and no poetry.`
      : ``;
    // The spine's retention shape differs by mode: a story builds to a dramatic
    // turn+payoff; a scenario is ONE escalating lived thread with no twist. The
    // story shape was leaking into scenarios and pulling them toward a "climax"
    // (a survey ending on a disaster) instead of one coherent experience.
    const spineStructure = isScenario
      ? `Structure it as ONE REPRESENTATIVE, PEACEFUL DAY, lived start to finish inside the single vantage point: beat 1 = the cold open above — WAKING UP calmly at the start of this man's day (before dawn to a bird, a bell, first light through the shutters). Then walk the day IN ORDER — waking, morning, the honest work and its familiar routine, midday, afternoon, a warm evening — each beat one concrete, contented moment that follows causally from the last and quietly shows how good and calm a simple day was. NEVER branch off to survey other people, places or events. There is no dramatic "twist" — the engine is the accumulating warmth of the hours. The LAST beat ENDS THE DAY: the man getting into bed at night, full and warm after a good day, and falling asleep — one plain detail, plain words. This wake-to-sleep shape is what makes the video feel COMPLETE and leaves the viewer wanting that life.`
      : `Structure it for retention: beat 1 = "hook" (the cold open above); an early "rehook" (~beat 2-3) that opens a second loop before curiosity dips; the stakes/tension RISE every beat with no flat middle; a clear "turn" around 60-70%; the LAST beat is "payoff" — the story's final real event, where the narration simply stops.`;

    // Opening stems differ by mode. A SCENARIO opens with the TIME + PLACE (the
    // grounding that makes it feel real and pleasant) then drops into the man
    // WAKING in second person — but with NO character name ("you are [Name], a
    // [job]" is banned). A STORY keeps the classic dated cold-open stems.
    const hookStems = isScenario
      ? (heroName
        ? `   - "It's [time of day], in [place], and you, ${heroName}, [wake / the first plain thing you do]…"  (e.g. "It's just after sunrise, in a bright hillside village, and you, ${heroName}, wake up to birdsong and warm light through the window.")
   KEEP the time and the place — that grounding makes it feel real and pleasant. You are ${heroName}, a man; use his name in the opening and lightly here and there after. Second person ("you"), present tense, plain everyday words, a calm happy day.`
        : `   - "It's [time of day / year], in [place], and you [wake / the first plain thing you do]…"  (e.g. "It's just before dawn in an English village in 1500, and you wake to a cold room and a rooster out in the yard.")
   KEEP the time/date and the place — that grounding is what makes it feel real and pleasant. Second person ("you"), present tense. Do NOT name yourself or say "you are [Name], a [job]" — you are simply "you". Plain everyday words.`)
      : `   - "It's [date/year]. [A person] is [mid-action]…"  (e.g. "It's August 10th, 1998. A night guard in Stockholm is starting his last round.")
   - "In a small town in [country/region], [a person does one concrete thing]…"  (also fine: "In [year], in [place], …")
   - "Imagine [being in this exact situation]…"
   Present tense, mid-scene, concrete.`;

    // ── Pass 1: architect the TRUE story spine (real facts + arc + a factual
    // ending). Planning the backbone up front is what makes the finished
    // narration feel complete and detailed instead of improvised — and it pins
    // the ending to a real payoff so the writer stops on a story beat, not a
    // tacked-on cringe closer.
    const outline = await this.callTool<{
      title?: string;
      angleOptions?: string[];
      setting?: string;
      hookOptions?: string[];
      hook?: string;
      ending?: string;
      spine?: Array<{ role?: string; fact?: string }>;
    }>(
      `${architectRole}

STAY ON TOPIC — this is non-negotiable. The finished video MUST be unmistakably about "${input.topic}". Someone who searched "${input.topic}" has to think "yes, this is exactly that", never "wait, why is this about something else".${directionBlock}

${architectStep1}

Work only from what you actually know: real names, dates, places, numbers, the telling human detail. No vague filler, no "some say", no invented facts. Tone is PLAIN AND CALM — told like a quiet true story, one person's real experience. The interest comes from real, concrete detail, NOT from hype or drama. This can simply be "how people lived / how X actually worked" — it does NOT need a shocking twist. Pick a thread the viewer can follow calmly, one thing at a time, and do not try to cram the whole topic in.

Output:

0. "angleOptions": the 3 distinct ${isScenario ? "vantage points" : "true-story angles"} you considered (one line each), all on-topic for "${input.topic}".

1. "hookOptions": exactly 3 candidate opening lines for the CHOSEN angle. HARD RULE — every option MUST begin in the form below (fill the brackets; the opening words stay as written):
${hookStems}
   Openers sounding the same video to video is FINE — this is the format, consistency is a feature.
   The first line NEVER announces or summarizes the story. BANNED first lines: "This is the story of…", "Did you know…", "The most X in history…", "Today…", introducing/naming the topic, or ANY line that gives away the premise. The viewer walks in on something already happening; the scene raises the question by itself.

2. "hook": the single STRONGEST of your 3 cold opens — the scene hardest to scroll away from, and one this true story can actually pay off. It MUST start with one of the stems above.

3. "setting": a rich VISUAL BIBLE (~60-90 words) that anchors every frame, TRUE to the topic's real world and time (whether that's centuries ago, present-day, or timeless — let the topic decide, don't default to "the past"). Name the 2-4 KEY PLACES this ${isScenario ? "scenario" : "story"} actually visits, and for EACH give its DEFINING, accurate signifiers — materials, structure, scale, the specific objects and clothing that belong to THIS topic's setting — precise enough that someone who knows it can't nitpick it, and DETAILED enough to fill a rich background (name the small props, textures and surroundings, not just the headline object). ACCURACY IS THE POINT: "a bunker" is a fail; "a WWI front-line dugout: timber-braced low earth ceiling, sandbag walls, wooden duckboard floor, a guttering candle, men crammed on a narrow bench, rifles stacked" is right — and a modern topic gets the same care ("a bright modern kitchen: steel counters, a hissing espresso machine, chalk menu board, tiled wall"). Everything belongs to the topic's own time — for a past setting no modern objects; for a present-day one no old-timey props. Also MAP THE SPACE so the world stays consistent and mappable: mark each key place as INSIDE or OUTSIDE, and note briefly how they connect (the bedroom opens onto the kitchen; the door leads out to the yard; the lane runs down to the market), so every beat can be placed in the right spot and the same place looks the same each time it reappears. For each INSIDE place, name its KEY FIXED FIXTURES and roughly WHERE they sit (the bed against the far wall under the window, the fireplace/hearth in the corner, the table in the middle) — these are anchored: the bed, the fire and the furniture stay in the SAME positions every time that place is shown, never rearranged. Also pin the palette/weather/light, and the protagonist's FIXED look INCLUDING his OUTFIT, kept consistent within each DAY: he wears ONE outfit for a given day ("a plain brown coat and grey trousers") that stays the same across that day's scenes, and if the story spans MORE THAN ONE DAY, a fresh outfit per day. Also name any deliberate mid-day change the story calls for (a hooded cloak once it rains, nightclothes once he's in bed) so those are consistent too, not random. Concrete and specific, never generic — this is what makes the world unmistakable and immersive.

${architectEnding}

5. "spine": the ordered beats — ${minBeats === maxBeats ? `EXACTLY ${maxBeats}` : `at least ${minBeats}, up to ${maxBeats}`}, one per key ${isScenario ? "moment of the scenario" : "story moment"}. Each beat has:
${architectSpineRoles}
   - "fact": the concrete real thing that happens in this beat, one line — and every fact NAMES its people and places outright (real names, dates, amounts): "Glyndwr Michael, a homeless Welshman, dies in London in January 1943", never "a man dies". No bare he/they/the man in a spine fact.
   KEEP THE CAST TIGHT: give NAMES only to the 1-3 people the story actually returns to, and the first fact that names someone must say who they are ("a British spy, Ewen Montagu"). Everyone who appears only once stays a role, never a name (a coroner, a fisherman) — a name the viewer meets once and never again just confuses.
   The spine is a CHAIN, not a list: each fact must follow causally from the one before (this happened, SO that happened). ${spineStructure} NO wrap-up or resolution beat after it. Use only as many beats as the true story needs — don't pad.

Call submit_outline.`,
      {
        name: "submit_outline",
        description: "Submit the chosen story: hook options, the winning hook, and the researched spine.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            angleOptions: {
              type: "array",
              items: { type: "string" },
              description: "the 3 distinct on-topic story angles considered, one line each (the chosen one is expanded below)",
            },
            hookOptions: {
              type: "array",
              items: { type: "string" },
              description:
                "exactly 3 cold-open first lines (date / place / imagine), in-scene and present tense, never announcing the story",
            },
            hook: {
              type: "string",
              description: "the strongest cold open — drops the viewer mid-scene; never summarizes the premise",
            },
            setting: {
              type: "string",
              description: "one compact line of concrete on-topic visual markers + recurring character look",
            },
            ending: {
              type: "string",
              description: "the story's final fact, stated plainly — no moral, CTA, question, or punchline",
            },
            spine: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: {
                    type: "string",
                    description: "hook | rehook | setup | rising | turn | payoff",
                  },
                  fact: { type: "string", description: "the concrete real event + specific detail for this beat" },
                },
                required: ["role", "fact"],
              },
            },
          },
          required: ["title", "angleOptions", "hookOptions", "hook", "setting", "ending", "spine"],
        },
      },
      // Scales with the spine AND leaves room for high-effort reasoning, which
      // shares this ceiling: a 44-50 beat spine plus reasoning overflowed the old
      // ~6000 and truncated the tool call (→ "no beats"). Ceiling only, billed by
      // use, so budget generously.
      Math.max(8000, maxBeats * 140 + 5000),
      // effort: "high" — the architect is the brain (story pick + arc + on-topic
      // faithfulness); reasoning here is where the quality gain lives.
      { model: this.commentaryModel, effort: "high" },
    );

    const spine = asArray<{ role?: string; fact?: string }>(outline.spine)
      .map((s) => ({ role: String(s.role ?? "").trim(), fact: String(s.fact ?? "").trim() }))
      .filter((s) => s.fact);
    const planSetting = String(outline.setting ?? "").trim();
    const planEnding = String(outline.ending ?? "").trim();
    const planHook = String(outline.hook ?? "").trim();
    const spineText = spine.length
      ? spine.map((s, i) => `${i + 1}. [${s.role || "beat"}] ${s.fact}`).join("\n")
      : `(no spine returned — build a complete, factual arc about ${input.topic} yourself)`;

    // ── Pass 2: narrate the spine into the finished, spoken story.
    const result = await this.callTool<{
      title?: string;
      description?: string;
      hashtags?: string[];
      setting?: string;
      beats?: Array<{ text?: string; imagePrompt?: string; delivery?: string }>;
    }>(
      `${narratorFraming}

OPENING HOOK — beat 1's "text" MUST START with these exact words, and NOTHING may come before them (no topic introduction, no setup sentence, no title read-out): ${planHook || (isScenario ? (heroName ? `open with the time and PLACE, then the man waking, in second person, naming him — "It's [time], in [place], and you, ${heroName}, wake…"` : 'open with the time/date and PLACE, then the man waking, in second person — "It\'s [time], in [place], and you wake…" — but do NOT name yourself ("you are [Name], a [job]" is banned)') : 'cold-open inside the scene, starting literally with "It\'s [date]…", "In a small town in…" or "Imagine…" — never announce what the story is about')}
VISUAL WORLD (setting): ${planSetting || "(derive a concrete, on-topic world)"}
STORY SPINE — follow this order, one beat each:
${spineText}
ENDING TO LAND ON: ${planEnding || "the story's real final consequence"}${directionBlock}

HOW TO WRITE IT:
- Conversational, spoken aloud — contractions, varied sentence length, vivid concrete detail. No throat-clearing, no "in this video", no wiki-summary tone.
- Narrator persona: "${narrator}", but keep it PLAIN AND CALM overall — a quiet, warm telling, like a person recounting a real experience, NOT hyped. The interest comes from the real detail, not from selling it. Some gentle rise and fall is fine; do NOT force drama, a big climax, or a "you won't believe" energy.
- POSITIVE, CALM LENS — make it feel like a nice, ordinary, peaceful day the viewer would want. For each chore, pick the plain GOOD side (the food is warm, the work goes well, people are friendly, the weather is fine) and skip anything miserable or hard. Do NOT editorialise ("life was hard", "so sad", "so peaceful") — just tell the good day and let it speak. This is NOT hype: no "amazing", no wonder, no exclaiming over simple things. Calm and content, not excited.
- ONE IDEA PER BEAT. Each beat says ONE simple thing and lets it land. Do NOT stack multiple facts, numbers or names into a sentence — the anti-pattern is a beat like "your meat isn't measured in weight but in money, one shilling and tuppence a week, about one chop, and the butcher snips the coupon before he cuts it." That overloads the viewer and they leave. Break ideas apart; give each its own calm beat. Fewer facts, told clearly, beats many facts crammed in. ${beatLengthGuidance}
- PLAIN WORDS, NO JARGON. Tell it in everyday language. Do NOT dump period terminology or stop to define words — no "that's the banca rotta, the word we still say as bankrupt", no "the Podestà, the city's chief magistrate", no "cessante e fuggitivo". If a foreign or old term is truly needed, use it lightly in passing; never make a teaching moment of it ("X is called Y", "the word comes from…"). People are watching for a calm story, not a vocabulary lesson.
- UTTERLY SIMPLE, NOT POETIC — this is a HARD rule the scripts keep failing. Use the plainest everyday word EVERY time, the way a normal person talks to a friend. Do NOT write like a poet or a novelist. BANNED "AI-poetry" words (and anything of that flavour): amber, hearth, glow, golden, gilded, aglow, crisp, weary, nestled, bustling, serene, tranquil, humble, tender, embrace, dawn breaks, the world stirs, drift/drifting off, a symphony of, dance of. Say it plainly instead — "fire" not "hearth", "warm orange light" not "amber glow", "tired" not "weary", "fall asleep" not "drift off", "the sun comes up" not "dawn breaks". NO rhyming, NO sing-song rhythm, and NO three-things-in-a-row lists ("the X, the Y, and the Z") — those flowery lists and pretty rhythms are the #1 dead giveaway of AI writing. Short, flat, plain sentences a 12-year-old would say out loud.
- LENGTH: the whole spoken narration must run BETWEEN ${minWords} and ${maxWords} words (~150 words/min, so roughly ${describeLength(minWords)}-${describeLength(maxWords)}). ${minWords} words is a FLOOR, not a suggestion — a story that lands short is not finished, so go back and give the setup and the turn the detail they deserve. Never pad with filler or repetition to reach it: earn the length with concrete specifics — names, dates, amounts, what someone actually said or did.

RETENTION MECHANICS (this is the job):
- COLD OPEN: the very FIRST WORDS of the whole narration are the opening hook above.${isScenario ? (heroName ? ` Open with the time and PLACE, then the man waking, present tense, naming him ("It's [time], in [place], and you, ${heroName}, wake…") — keep the grounding, and you ARE ${heroName}.` : ' Open with the time/date and PLACE, then the man waking, present tense ("It\'s [time], in [place], and you wake…") — that grounding is good, KEEP it — but do NOT name yourself ("you are [Name], a [job]" is banned). You are simply "you".') : ' Start "It\'s…", "In…" or "Imagine…"; the viewer lands mid-scene (a date, a place, a person in motion), present tense.'} NEVER announce or summarize what the video is about before or after the hook's first line ("This is the story of…" is banned); the scene raises the question by itself.
- ${isScenario ? (heroName ? `YOU ARE ${heroName} — use his name in the opening and lightly now and then (not every beat), and anchor with PLACES and THINGS (the market, the river, the workshop) so it's always clear where you are and what you're doing. You may name at most ONE other person the day returns to, introduced in one clause on first mention.` : "NO NAME FOR YOU — you are just \"you\", never named. Anchor with PLACES and THINGS instead (the village, the river, the bakehouse) so it's always clear where you are and what you're doing. You may name at most ONE other person the day returns to (a neighbour), introduced in one clause on first mention.") : "NAMES ANCHOR EVERYTHING: introduce the main character BY NAME within the first two beats and keep USING the names — people, places, dates, amounts, in almost every beat. Never chain pronouns across beats (\"he… they… it…\"); re-anchor with the name or clear role each beat so a viewer always knows WHO is doing WHAT, WHERE."} Rich specifics are what make the story feel real and easy to follow.
- INTRODUCE EVERY NAMED PERSON ON FIRST MENTION: the first time a name appears, say in one clause WHO they are and why they matter ("a British spy named Ewen Montagu", "the town's coroner, Bentley Purchase") — never drop a bare surname the viewer has never met. And only NAME people the story comes back to; a one-off person who appears once is a role, not a name ("a fisherman", "a border guard"), so the cast stays small and nobody is confused by a name they can't place.
- CHAIN THE BEATS: every beat after the first OPENS by linking to the previous one ("So…", "That's when…", "Because of that…", "Three days later…") — one continuous told story, never a list of facts. Before submitting, read the whole narration start to finish and smooth ANY seam that feels like a jump; coherence beats cleverness.
- NO AI TELLS — this is a hard rule. NEVER use the hype connectives that scream machine-written: "here's the strange part", "here's the wild/crazy/weird part", "but that's not the worst part", "here's the kicker", "plot twist", "here's where it gets interesting", "but here's the thing". If a detail is interesting, just tell it plainly and let it be interesting on its own. Move between beats with quiet, natural links, not hooks.
- KEEP IT MOVING GENTLY: each beat should carry the story a step forward so it never stalls — but through natural progression, NOT forced escalation. It's fine for the middle to be calm; a plain, clear telling holds better than manufactured tension. Do not build toward a manufactured climax.

ENDING RULES (critical — this is what's been going wrong):
- The narration ends ON the story's final fact (the "ending" above): the LAST SENTENCE is simply the last thing that happened, stated plainly. Then it STOPS.
- NO END PUNCH of any kind: no punchline, kicker, button, callback line, clever flourish, or summary sentence. Do NOT "craft" a closing line at all — the final event IS the closing line. If it feels abrupt, that is correct.
- BANNED closers — NEVER end the narration with any of these: a call-to-action or "follow for more"/hashtag-speak; a tacked-on moral or life lesson; "let that sink in", "makes you wonder", "and the rest is history", "and that's the story of…", "mind = blown", "little did they know"; or a rhetorical question. The last line is part of the STORY, not a comment on it.${narratorEnding}

For EACH beat give:
- "text": the spoken narration (1-3 sentences — use the third when the beat needs its connective tissue or a telling detail).${
        input.voiceTags
          ? ` Embed 1-2 ElevenLabs audio tags inline where the read shifts (acted, not spoken): [pause], [whispers], [excited], [sighs], [laughs], [curious].`
          : ""
      }
- "imagePrompt": DRAW WHAT THIS LINE DESCRIBES. If the narration names a specific place, object, structure, or event — "a hall with fifty doors, each wide enough to march through shoulder to shoulder", "a phalanx of soldiers locking shields", "a clay tablet covered in wedge marks" — that concrete thing IS the picture, rendered with its stated specifics (fifty doors, not "a hall"; shields locked, not "soldiers"). Do NOT default to the character standing in a vague background while the interesting thing goes undrawn — that is the single most common failure. The stick figure appears only when the line is about a person acting/reacting, and even then the described SCENE around them must be specific and correct. Every prompt names the concrete subject first, then the setting's markers, then (optionally) the figure and its expression. ACCURACY: pull the DEFINING features from the setting so the place is unmistakably itself and can't be nitpicked — the right materials, structures and objects for the topic's real time and place (historical or modern), nothing that doesn't belong in it, and enough surrounding detail that the background feels full rather than bare.${
        isScenario
          ? " IMMERSION: favour second-person / over-the-shoulder / POV framing that drops the viewer INSIDE the scene — \"from inside the dugout looking out toward the doors\", \"over your own shoulder as the shields lock into a wall\" — so they feel they are there, not watching from outside."
          : ""
      } No text/letters in the image.
  DRAWABLE-SAFE (image prompts only — the narration is unaffected): the image API refuses graphic content, so NEVER put corpses, bodies, gore, blood, executions, weapons in use, or named real-world figures (Hitler, dictators, criminals) in an imagePrompt. IMPLY the dark beat instead: the empty rowboat, a covered stretcher, boots in the snow, a silhouette behind glass, officials huddled over a briefcase, the aftermath. Suggestion reads better on screen anyway.
- "delivery": 1-2 sentences on the emotion of this beat (feeds the read's arc).

Also give: "title"; "setting" (echo/refine the visual-world line above); "description" (1-2 sentences — a soft CTA is fine HERE in the description only, NEVER in the narration); up to 6 "hashtags".
Call submit_story.`,
      {
        name: "submit_story",
        description: "Submit the narrated story broken into beats.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
            setting: {
              type: "string",
              description:
                "the story's visual world: one compact line of concrete, on-topic place/era/character markers, threaded into every beat image",
            },
            beats: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", description: "spoken narration for this beat" },
                  imagePrompt: { type: "string", description: "simple stick-figure scene to draw for this beat" },
                  delivery: { type: "string", description: "how to read this beat: pace, pitch, emotion" },
                },
                required: ["text", "imagePrompt", "delivery"],
              },
            },
          },
          required: ["title", "description", "hashtags", "setting", "beats"],
        },
      },
      // Beats only (no duplicate `script` — it's rebuilt from beats downstream),
      // plus per-beat image prompt + delivery, plus reasoning which shares this
      // ceiling. Generous so 44-50 long-form beats never truncate. Ceiling only,
      // billed by actual use.
      Math.max(9000, Math.round(maxWords * 3) + maxBeats * 170 + 4500),
      // effort: "medium" — the narrator is execution (spine → coherent prose);
      // reasoning helps it chain beats without the cost of "high".
      { model: this.commentaryModel, effort: "medium" },
    );

    const cleanBeats = asArray<{ text?: string; imagePrompt?: string; delivery?: string }>(result.beats)
      .filter((b) => String(b.text ?? "").trim() && String(b.imagePrompt ?? "").trim())
      .map((b) => ({
        text: String(b.text).trim(),
        imagePrompt: String(b.imagePrompt).trim(),
        ...(String(b.delivery ?? "").trim() ? { delivery: String(b.delivery).trim() } : {}),
      }));
    return {
      title: String(result.title ?? outline.title ?? input.topic).slice(0, 120),
      script: cleanBeats.map((b) => b.text).join(" "),
      description: String(result.description ?? ""),
      hashtags: hashList(result.hashtags),
      setting: String(result.setting ?? "").trim() || planSetting,
      beats: cleanBeats,
    };
  }

  async planCookShots(input: PlanCookInput): Promise<CookPlan> {
    // Ceiling must track COOK_MAX_SHOTS (12) — a lower clamp here silently caps
    // the video's length no matter what the env says.
    const maxShots = Math.max(3, Math.min(12, input.maxShots));
    const aspect = input.aspectRatio || "9:16";
    const result = await this.callTool<{
      title?: string;
      description?: string;
      hashtags?: string[];
      styleBible?: string;
      shots?: Array<{ state?: string; action?: string; camera?: string; audio?: string; frame?: string }>;
    }>(
      `You are the SHOT PLANNER for a "cook-in-the-wild" ASMR video (the viral genre: cooking in nature, ${aspect} vertical, NO narration, native ambient sound, a hard cut every ~8-10 seconds, every step shown). The dish: "${input.dish}".

The whole game is CONSISTENCY across cuts. The video model invents anything you leave unspecified, and it invents it differently every shot (a rock off the fire one cut, oil appearing from nowhere the next). Retrying does not fix that — the SPEC must. So pin EVERY aspect.

1. "styleBible" — ONE dense block, the immutable look repeated on every shot. It MUST lock all of:
   - SETTING: the exact outdoor place (e.g. a riverside by a clear rushing stream), fixed.
   - HEAT SETUP: state explicitly where the heat is — e.g. "a flat cooking stone resting DIRECTLY ON a low campfire, flames and glowing embers visible underneath it, heating it from below". The cooking must be physically possible.
   - PROPS: the fixed cast of objects (specific bowls, board, utensils) — nothing new appears later.
   - HANDS: "only weathered bare hands, no rings, no face, no body, no second person".
   - LIGHT + EXPOSURE: "soft overcast daylight in open shade, balanced natural exposure, muted earthy tones, NO blown-out highlights, NO harsh glare, NO golden glow" (blown highlights are a known failure).
   - CAMERA: photorealistic cinematic close-up, shallow depth of field, subtle handheld movement, ${aspect} vertical.
   - HARD RULES: "everything visible is present from the first frame — nothing appears, changes, or vanishes mid-shot unless the on-screen action causes it; no on-screen text, no watermark, no music, no voices, no cartoon or CGI look".

2. "shots" — the ordered cooking steps (minimum 3, up to ${maxShots}), one continuous ~8s action each. Each shot pins:
   - "state": the food's EXACT current condition, carried forward from the previous shot (raw → rinsed → seasoned → sizzling → browned → plated). This is continuity — the fish rinsed in shot 1 is the fish seasoned in shot 2.
   - "action": ONE clear continuous action for this ~8s beat (rinse, season, mix a paste, lay on the hot stone → sizzle, pour water → steam, plate). No implied off-screen jumps.
   - "camera": the framing + any slow move.
   - "audio": the explicit native ambient sound for this shot (sizzle, crackling fire, running water, steam hiss, birdsong) — ambient only, never music or voices.
   - "frame": a still-photograph description of this shot's OPENING FRAME — the exact composition at the instant before the action starts, written for a photo model (no motion verbs, no "then"). This still is generated first and becomes the clip's first frame, so it must describe the food's state, the stone on the fire, the props in shot and where the hands are.
   Make it a real, appetising sequence a viewer watches start to finish. Physically logical throughout.

Also give a scroll-stopping "title", a 1-2 sentence "description" (a soft CTA is fine here), and up to 6 "hashtags".
Call submit_cook.`,
      {
        name: "submit_cook",
        description: "Submit the locked style bible and the continuity-threaded cooking shot list.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
            styleBible: {
              type: "string",
              description: "the immutable look — setting, heat setup, props, hands, exposure, camera, hard rules — repeated on every shot",
            },
            shots: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  state: { type: "string", description: "the food's exact current condition, carried from the previous shot" },
                  action: { type: "string", description: "one clear continuous ~8s action" },
                  camera: { type: "string", description: "framing + any slow move" },
                  audio: { type: "string", description: "explicit native ambient sound; no music/voices" },
                  frame: {
                    type: "string",
                    description: "still-photo description of the opening frame — composition at rest, no motion verbs",
                  },
                },
                required: ["state", "action", "camera", "audio", "frame"],
              },
            },
          },
          required: ["title", "description", "hashtags", "styleBible", "shots"],
        },
      },
      4000,
      // effort "high": the planner is the whole product — an exhaustive,
      // continuity-locked spec is what makes the clips cut together.
      { model: this.commentaryModel, effort: "high" },
    );

    const bible = String(result.styleBible ?? "").trim();
    // Assemble each shot's full prompt in code so the bible is byte-identical
    // across every shot — the strongest consistency lever (a model asked to
    // repeat it verbatim drifts).
    const shots = (result.shots ?? [])
      .map((s) => {
        const parts = [
          bible,
          String(s.state ?? "").trim() ? `STATE: ${String(s.state).trim()}` : "",
          String(s.action ?? "").trim() ? `ACTION: ${String(s.action).trim()}` : "",
          String(s.camera ?? "").trim() ? `CAMERA: ${String(s.camera).trim()}` : "",
          String(s.audio ?? "").trim() ? `AUDIO: ${String(s.audio).trim()}` : "",
        ].filter(Boolean);
        // The still prompt gets the SAME bible, so the frame the photo model
        // draws and the world the video model continues are one description.
        const frame = String(s.frame ?? "").trim();
        const imageParts = [
          bible,
          `FRAME (a still photograph, no motion): ${frame || String(s.state ?? "").trim()}`,
        ].filter(Boolean);
        return { prompt: parts.join("\n"), imagePrompt: imageParts.join("\n") };
      })
      .filter((s) => /ACTION:/.test(s.prompt));

    return {
      title: String(result.title ?? input.dish).slice(0, 120),
      description: String(result.description ?? ""),
      hashtags: hashList(result.hashtags),
      shots,
    };
  }

  async planPovShort(input: PlanPovInput): Promise<PovPlan> {
    // A POV short is a full minute-plus journey: 8s per clip, so 10-14 clips.
    const maxShots = Math.max(8, Math.min(16, input.maxShots));
    const result = await this.callTool<{
      title?: string;
      description?: string;
      hashtags?: string[];
      logline?: string;
      place?: string;
      date?: string;
      timeOfDay?: string;
      role?: string;
      worldBible?: string;
      shots?: Array<{ scene?: string; motion?: string; audio?: string }>;
    }>(
      `You are the SHOT PLANNER for a "POV: you wake up in <a real time and place in history>" short-form video (9:16 vertical, first-person, hard cut every ~8 seconds, NO narration — native ambient sound + on-screen text only). The subject: "${input.topic}".
${input.direction?.trim() ? `\nCREATOR DIRECTION (honour this — the angle, tone, what to show or avoid): ${input.direction.trim()}\n` : ""}
This is an EDUCATIONAL immersion piece and a FULL journey — it runs over a minute, so plan EXACTLY ${maxShots} beats (10-14 is the target; 8s each). It must be HISTORICALLY GROUNDED and specific — real place, real date, real detail — not generic "medieval times".

First give a "logline" — ONE sentence describing what the viewer experiences start to finish (who they are, where/when they wake, and the journey they take). This is shown to the creator for APPROVAL before anything else, so make it a clear, honest summary of the whole short.

Pin these HOOK details (ONLY the place + date appear on screen — as the opening title card; the rest steer the writing):
- "place" — SHORT, for the on-screen title card: just the city (+ country), e.g. "Edo, Japan" or "Constantinople". Keep it a few words — put the specific spot (the warehouse, the back-lane lodging) in the worldBible, NOT here.
- "date" — a specific date or year that matters, e.g. "29 May 1453" (pick a day with weight when the subject implies one).
- "timeOfDay" — e.g. "Dawn".
- "role" — who the viewer is, in-world, e.g. "a Genoese dock worker". First-person, ordinary person.

Then "worldBible" — ONE dense block, the IMMUTABLE look repeated on EVERY clip. The clips are generated SEPARATELY, so anything you leave unpinned drifts between cuts (the sky clears in one shot and rains the next, your sleeve changes colour). The whole journey happens over a short span of the SAME morning, so time and weather are CONSTANT — lock all of:
   - PLACE: the exact setting and its architecture/materials, fixed.
   - DATE + TIME OF DAY: e.g. "just after dawn"; and the EXACT LIGHT it gives — direction, height and quality (e.g. "low golden sunlight raking from the east, long soft shadows"). Keep this light identical every shot.
   - WEATHER + SEASON: pin it explicitly (e.g. "clear cold early-spring air, a light breeze off the water, no clouds") — the SAME weather in every shot, never changing.
   - YOUR OWN BODY: "your own hands and forearms are the only body seen, drawn as a simple flat cartoon stick figure, [state the plain clothing + a fixed sleeve colour]; no face, no reflection, no second protagonist." Keep the clothing/sleeve identical every shot.
   - PALETTE + CAMERA: the colour range and "first-person eye-level POV, 9:16 vertical, natural handheld".
   - HARD RULES: "STRICTLY FIRST-PERSON every shot — the camera IS your own eyes and NEVER pulls back, orbits, or cuts to a third-person/outside view; your torso, back, head, legs or full body are NEVER shown — only your forearms and hands enter from the lower edge. Everything consistent across cuts; the weather, light and time never change through the journey; no on-screen text except where a shot directs it; no music, no voices."

Then "shots" — the ordered POV beats (EXACTLY ${maxShots}). The ARC is a continuous first-person JOURNEY through the day, not a single reveal:
  1. WAKE looking FORWARD into the dim room — the camera already faces forward/level into the space (your eyes open on the room, or you are already sitting). Do NOT lie flat and haul yourself upright — that motion forces the camera to swing and the model breaks to a third-person shot of you. Keep it gentle and forward-facing: your hands simply come up and push the cover down and away from you.
  2. RISE and cross to an opening (window/door) — the wider world is REVEALED (the early payoff).
  3. STEP OUT and MOVE THROUGH the place: walk the street/dock/market, your hands touching real things (a door latch, market goods, a rope, coins), passing people and architecture, small encounters — a sequence of distinct first-person moments that TOUR the historical world.
  4. END on a strong, memorable final image (a landmark up close, the harbour, a threshold).
Every beat is a NEW location or action that moves you forward — never repeat the same view. Each beat pins:
- "scene": the STILL world in front of you at the start of the beat — a still-photograph description, no motion verbs. Historically specific props and architecture, DIFFERENT each beat as you move.
- "motion": ONE continuous ~8s FIRST-PERSON motion the camera can show WITHOUT ever turning to look at yourself — forward-facing only: walking forward, reaching a hand out toward something, opening a door/shutter, looking across a view, climbing steps. Your hands/forearms may enter from the bottom, but the camera NEVER pulls back to reveal your body and NEVER shows a third-person view. AVOID motions that only read in third person (sitting up from lying flat, standing from a bow, turning to see your own back).
- "audio": the native ambient sound for this beat (a crackling lamp, floorboards, gulls, market chatter, cart wheels on stone) — ambient only, never music or voices.
Do NOT describe the protagonist's face or a third person as the subject — it is first-person (other people can appear around you). Do NOT mention art style — that is added later. There is NO on-screen text on any beat except the opening title card (place + date), which is added separately — do not put captions or writing into the scenes.

Also give a scroll-stopping "title", a 1-2 sentence "description", and up to 6 "hashtags".
Call submit_pov.`,
      {
        name: "submit_pov",
        description: "Submit the historically grounded POV overlay facts and the wake→reveal journey beats.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
            logline: { type: "string", description: "one-sentence summary of the whole short, for creator approval" },
            place: { type: "string" },
            date: { type: "string" },
            timeOfDay: { type: "string" },
            role: { type: "string" },
            worldBible: {
              type: "string",
              description: "the immutable world lock — place, date/time+light, weather+season, the viewer's body/clothing, palette, camera, hard rules — repeated verbatim on every clip",
            },
            shots: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  scene: { type: "string", description: "still world at the start of the beat, no motion verbs" },
                  motion: { type: "string", description: "one continuous ~8s first-person motion" },
                  audio: { type: "string", description: "native ambient sound; no music/voices" },
                },
                required: ["scene", "motion", "audio"],
              },
            },
          },
          required: ["title", "description", "hashtags", "logline", "place", "date", "timeOfDay", "role", "worldBible", "shots"],
        },
      },
      // Generous budget: a dense worldBible + 12 beats (scene/motion/audio each) +
      // logline is a lot of output. At 3000 it truncated mid-`shots`, yielding a
      // plan with a logline but ZERO beats (which then crashed the upload view).
      8000,
      // effort "high": the plan is the whole product — the reveal arc and the
      // factual grounding are what make the short land.
      { model: this.commentaryModel, effort: "high" },
    );

    const shots = (result.shots ?? [])
      .map((s) => ({
        scene: String(s.scene ?? "").trim(),
        motion: String(s.motion ?? "").trim(),
        audio: String(s.audio ?? "").trim(),
      }))
      .filter((s) => s.scene && s.motion);

    return {
      title: String(result.title ?? input.topic).slice(0, 120),
      description: String(result.description ?? ""),
      hashtags: hashList(result.hashtags),
      logline: String(result.logline ?? "").trim(),
      place: String(result.place ?? input.topic).trim(),
      date: String(result.date ?? "").trim(),
      timeOfDay: String(result.timeOfDay ?? "").trim(),
      role: String(result.role ?? "").trim(),
      worldBible: String(result.worldBible ?? "").trim(),
      shots,
    };
  }

  async expandImagePrompts(input: ExpandImagePromptsInput): Promise<string[][]> {
    if (input.beats.length === 0) return [];
    // Shared, provider-neutral instruction (also used by DeepSeek, which normally
    // runs this) — only the output directive differs (tool call here).
    const result = await this.callTool<{ beats?: Array<{ prompts?: string[] }> }>(
      `${buildExpandFramesInstruction(input)}\nCall submit_frames.`,
      {
        name: "submit_frames",
        description: "Submit the expanded per-beat frame prompts.",
        input_schema: {
          type: "object",
          properties: {
            beats: {
              type: "array",
              description: "one entry per beat given, in the same order",
              items: {
                type: "object",
                properties: {
                  prompts: {
                    type: "array",
                    items: { type: "string" },
                    description: "successive moments of this beat, exactly the requested count",
                  },
                },
                required: ["prompts"],
              },
            },
          },
          required: ["beats"],
        },
      },
      // Scales with the work: a long-form story can send 40+ beats needing 3
      // frames each, and a fixed budget would truncate the tail into missing
      // prompts (which then silently reuse the beat's original frame).
      // ~110 tok/frame: each shot now leads with its state clause, so 60 would
      // truncate the tail into missing prompts (which reuse the base frame).
      Math.max(3000, input.beats.reduce((n, b) => n + b.count, 0) * 110 + 2000),
    );

    return alignExpandedFrames(input, asArray(result.beats));
  }

  async planAnimationShots(input: PlanAnimationInput): Promise<{ cast: string; shots: AnimShot[] }> {
    if (input.beats.length === 0) return { cast: "", shots: [] };
    const listing = input.beats
      .map((b, i) => `${i + 1}. NARRATION: "${b.text}"\n   SCENE: ${b.imagePrompt}`)
      .join("\n");

    const result = await this.callTool<{
      cast?: string;
      shots?: Array<{ imagePrompt?: string; motionPrompt?: string }>;
    }>(
      `These narrated beats are being turned into an ANIMATED short: each beat becomes one ~6-second generated video clip of stick figures actually moving — walking, reaching, recoiling, collapsing — not a still with a camera drift over it. Six seconds is short: one action, performed fully, with no dead air at either end.

WORLD (every shot lives here): ${input.setting || "unspecified"}
The art style is TRUE simple stick figures: plain circle heads, single-line limbs, no faces beyond the simplest marks, flat colourful backgrounds. Never detailed or realistic characters.

${listing}

First give me "cast" — the CAST SHEET. One line per figure who appears in more than one beat, describing ONLY what is visible: height relative to the others, what they wear, what they carry, hair, any single distinguishing mark. Give each a short visual label you will reuse ("the tall figure in the long brown coat"). No names, no backstory, no personality — just what a viewer sees. This block is repeated verbatim into every shot, and it is the ONLY thing making a figure recognisable from one clip to the next, so make each description concrete and easy to draw the same way twice, and make the figures easy to tell apart from each other.

Then for each beat give me two things:
- "imagePrompt": the FIRST FRAME as a still — the composition at the instant the beat begins. Where each figure stands, their pose, what's in frame, the background. No motion words. This still is drawn first and handed to the video model, so it is what keeps the characters looking identical from clip to clip: describe the recurring figures the SAME way every time (same colours, same size, same markings).
- "motionPrompt": the ACTING for this beat — what the figures physically DO across the ~6 seconds. This is the difference between animation and a photo that drifts, so write it like an animator, not like a caption.

HOW TO WRITE motionPrompt — this is the whole job:
- Give the shot a SHAPE with three parts, in order: the WIND-UP (a small opposite move first — leaning back before lunging, crouching before a jump, shoulders rising before a slump), the ACTION itself, and the SETTLE (what the body does after — stumbling a step, arms swinging past and coming back, a shoulder drop). A move without a wind-up and a settle reads as a puppet snapping between poses.
- ONE clear action per beat, but describe it as it unfolds in time: "she plants her feet and leans back, then hauls the crate up in one heave and staggers two steps before catching her balance."
- ACT WITH THE WHOLE BODY. These figures have almost no faces — a couple of marks at most — so every emotion has to be carried by posture, timing and silhouette. Shock is the whole body recoiling and arms flying up, not a facial expression. Defeat is the spine curling and the head dropping. Never write "looks surprised" or "seems angry"; write what the body does.
- EXAGGERATE. Push the poses past what a real person would do — bigger reach, deeper crouch, wider stagger. Flat, realistic movement on a stick figure reads as stiff and lifeless.
- Keep the SILHOUETTE readable: limbs held away from the body so the pose is clear against the background, never a tangle of overlapping lines.
- The camera may move when it helps — a slow push in on a reaction, a pan following someone walking. Say so explicitly when you want it. Just don't cut.
- Motion the narration implies, nothing extra. No new characters appearing mid-shot.

Rules:
- Exactly one continuous action per beat. If the narration covers two events, animate the one that carries it.
- Keep the cast tight and consistent; a figure introduced in beat 1 looks the same in beat 7.
- NEVER WRITE A REAL PERSON'S NAME. The video model refuses any prompt that names or resembles a real person, living or dead, and that refusal wastes the whole shot. The narration says the names out loud; the PICTURES must not. Identify every figure by appearance and role instead — "the tall figure in the long brown coat", "the shorter figure holding the clipboard", "the figure in the peaked cap". Use the SAME description for the same person in every beat, since that description is all that keeps them recognisable. This applies to place-brands and logos too: "a government building", not a named one.
- No on-screen text, no words, no letters anywhere in frame.
- Return one entry per beat, in order.
Call submit_animation.`,
      {
        name: "submit_animation",
        description: "Submit the per-beat first-frame and motion prompts.",
        input_schema: {
          type: "object",
          properties: {
            cast: {
              type: "string",
              description:
                "one visual line per recurring figure, with a reusable label; appearance only, no names",
            },
            shots: {
              type: "array",
              description: "one per beat, in order",
              items: {
                type: "object",
                properties: {
                  imagePrompt: { type: "string", description: "the first frame as a still; no motion words" },
                  motionPrompt: { type: "string", description: "one continuous physical action over ~8s" },
                },
                required: ["imagePrompt", "motionPrompt"],
              },
            },
          },
          required: ["cast", "shots"],
        },
      },
      5000,
      // The look has to survive N independent clips, so this is worth reasoning on.
      { model: this.commentaryModel, effort: "medium" },
    );

    // The cast sheet is prepended in CODE, not by asking the model to repeat it.
    // Byte-identical repetition is the point — a model asked to restate a
    // description each time drifts, and drift is exactly what breaks a character
    // across clips. Same reason the cook style bible is assembled here.
    const cast = String(result.cast ?? "").trim();
    const withCast = (frame: string) => (cast ? `CAST (unchanged in every shot):\n${cast}\n\n${frame}` : frame);

    const shots = input.beats.map((b, i) => {
      const s = result.shots?.[i];
      return {
        text: b.text,
        imagePrompt: withCast(String(s?.imagePrompt ?? b.imagePrompt).trim() || b.imagePrompt),
        motionPrompt: String(s?.motionPrompt ?? "").trim() || `slow natural movement matching: ${b.text}`,
      };
    });
    return { cast, shots };
  }

  async planCall(input: PlanCallInput): Promise<CallPlan> {
    const seconds = Math.max(20, Math.min(90, input.maxSeconds));
    const result = await this.callTool<{
      title?: string;
      description?: string;
      hashtags?: string[];
      premise?: string;
      setup?: string;
      characters?: Array<{
        name?: string;
        role?: string;
        gender?: string;
        age?: string;
        accent?: string;
        voice?: string;
        personality?: string;
        agenda?: string;
        quirks?: string;
      }>;
      escalation?: string[];
      ragebait?: string[];
      ending?: string;
      direction?: string;
      imagePrompts?: string[];
    }>(
      `You are the DIRECTOR of a short-form "recorded phone call" video — the rage-bait genre where a call between two people is posted with captions and the comments section does the rest. The user's idea: "${input.idea}".

You are NOT writing dialogue. You are writing the BRIEF that a voice model will improvise the call from. Improvised talk sounds real; written lines sound written. So your job is to pin down everything the improvisation must not get wrong, and nothing else.

What makes this genre work:
- ONE clear situation the viewer understands in three seconds. If they have to work out who these people are, they scroll.
- An imbalance of power or patience. Someone wants something, the other person will not give it, and neither will hang up.
- SPECIFICS carry the rage. Not "he was rude" — a number, a name, a policy, a price, a rule that is almost defensible. The comments are people arguing about the specific.
- The two voices must be unmistakably different people: different accent, different tempo, different vocabulary, different fillers. This is the single biggest realism lever.
- It escalates. It does not resolve. It cuts on the peak.

Give me:
1. "premise" — one line: what this call IS.
2. "setup" — the situation, told so a stranger gets it instantly (who called whom, why, what's at stake).
3. "characters" — EXACTLY 2. For each: "name" (a plain first name, used as the speaker label), "role", "gender" ("male"/"female"), "age" (band, e.g. "late 40s"), "accent" (accent AND delivery: tempo, pitch, volume, how they sound when they get annoyed), "voice" (pick a voice id from the catalogue below that fits), "personality", "agenda" (what they want out of this call — the engine), "quirks" (fillers, catchphrases, tics, the phrase they keep repeating).
   VOICE CATALOGUE (use these ids exactly): ${voiceCatalogue()}
   Pick two voices that sound nothing alike.
4. "escalation" — 4 to 6 ordered BEATS describing how the call turns, in plain terms ("she stays polite and it makes him worse"). Beats, never lines.
5. "ragebait" — 3 to 5 concrete infuriating specifics to work in naturally (the number, the rule, the excuse, the thing they say that everyone has heard before).
6. "ending" — where it cuts. On the peak. No apology, no resolution, no punchline, no "and that's why…".
7. "direction" — how the whole thing should be performed as a recording: overlapping, interrupting, phone-line realism, silences, the moment the tone changes.
8. "imagePrompts" — 3 simple still-image prompts for the on-screen visual (the video is audio-led): the two people mid-call, their surroundings, drawn simply. No text in the image, no faces of real people.
9. "title" (scroll-stopping, ${seconds}s video), "description" (1-2 sentences; it must make clear this is a fictional/AI-made bit), up to 6 "hashtags".

HARD LIMITS — this has to survive platform review and not get the account struck:
- Everyone is FICTIONAL. No real people, no real companies, banks, agencies, brands or public figures. Invent the names.
- No real phone numbers, addresses, or account numbers.
- No slurs, no sexual content, no threats of real violence, no targeting a real identifiable person.
- Never claim it's a genuine recording. Anger at a situation, not hate at a group.
The call is about ${seconds} seconds of speech, which is roughly ${Math.round((seconds / 60) * 150)} words of dialogue — pace the escalation for that, not for a 5-minute call.
Call submit_call.`,
      {
        name: "submit_call",
        description: "Submit the full call brief: premise, cast, escalation beats, rage-bait specifics and ending.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
            premise: { type: "string", description: "one line: what this call is" },
            setup: { type: "string", description: "the situation, instantly graspable" },
            characters: {
              type: "array",
              description: "exactly 2 speakers",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "plain first name, used as the speaker label" },
                  role: { type: "string" },
                  gender: { type: "string", enum: ["male", "female"] },
                  age: { type: "string" },
                  accent: { type: "string", description: "accent AND delivery: tempo, pitch, how they sound annoyed" },
                  voice: { type: "string", description: "a voice id from the catalogue" },
                  personality: { type: "string" },
                  agenda: { type: "string", description: "what they want out of this call" },
                  quirks: { type: "string", description: "fillers, catchphrases, tics" },
                },
                required: ["name", "role", "gender", "age", "accent", "voice", "personality", "agenda", "quirks"],
              },
            },
            escalation: { type: "array", items: { type: "string" }, description: "4-6 ordered beats, never lines" },
            ragebait: { type: "array", items: { type: "string" }, description: "3-5 concrete infuriating specifics" },
            ending: { type: "string", description: "where it cuts — on the peak, unresolved" },
            direction: { type: "string", description: "how it should be performed as a recording" },
            imagePrompts: { type: "array", items: { type: "string" }, description: "3 simple still prompts" },
          },
          required: [
            "title",
            "description",
            "hashtags",
            "premise",
            "setup",
            "characters",
            "escalation",
            "ragebait",
            "ending",
            "direction",
            "imagePrompts",
          ],
        },
      },
      4000,
      // effort "high": the brief IS the product here — the audio model only ever
      // sees this, so a vague cast or a soft escalation can't be fixed later.
      { model: this.commentaryModel, effort: "high" },
    );

    // EXACTLY two, always. The call format is two speakers by definition (the
    // TTS caps at two), and the response schema requires two — a short list from
    // the model would otherwise fail serialization and surface as an opaque 500
    // instead of a usable brief.
    const raw = asArray<NonNullable<typeof result.characters>[number]>(result.characters).slice(0, 2);
    while (raw.length < 2) raw.push({});
    const characters: CallCharacter[] = raw.map((c, i) => {
      const gender = c.gender === "female" ? "female" : c.gender === "male" ? "male" : i === 0 ? "male" : "female";
      return {
        name: String(c.name ?? (i === 0 ? "Caller" : "Recipient")).trim().slice(0, 40) || (i === 0 ? "Caller" : "Recipient"),
        role: String(c.role ?? (i === 0 ? "the caller" : "the person who answered")).trim(),
        gender,
        age: String(c.age ?? "").trim(),
        accent: String(c.accent ?? "").trim(),
        voice: resolveVoice(c.voice, gender, i),
        personality: String(c.personality ?? "").trim(),
        agenda: String(c.agenda ?? "").trim(),
        quirks: String(c.quirks ?? "").trim(),
      };
    });
    // Two speakers with the same voice are indistinguishable on the recording.
    if (characters[1]!.voice === characters[0]!.voice) {
      characters[1]!.voice = resolveVoice(undefined, characters[1]!.gender, 1);
      if (characters[1]!.voice === characters[0]!.voice) {
        characters[1]!.voice = resolveVoice(undefined, characters[1]!.gender, 2);
      }
    }

    // Non-empty: the schema requires at least one beat, and an empty list would
    // fail serialization rather than degrade.
    const beats = asArray<unknown>(result.escalation).map(String).filter(Boolean).slice(0, 6);
    const escalation = beats.length > 0 ? beats : ["the call opens politely and steadily gets worse"];

    return {
      title: String(result.title ?? input.idea).slice(0, 120),
      description: String(result.description ?? ""),
      hashtags: hashList(result.hashtags),
      premise: String(result.premise ?? input.idea),
      setup: String(result.setup ?? ""),
      characters,
      escalation,
      ragebait: asArray<unknown>(result.ragebait).map(String).filter(Boolean).slice(0, 5),
      ending: String(result.ending ?? ""),
      durationSeconds: seconds,
      direction: String(result.direction ?? ""),
      imagePrompts: asArray<unknown>(result.imagePrompts).map(String).filter(Boolean).slice(0, 4),
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
    return asArray<unknown>(result.hooks).map(String).slice(0, 3);
  }
}
