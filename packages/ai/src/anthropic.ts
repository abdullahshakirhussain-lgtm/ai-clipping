import Anthropic from "@anthropic-ai/sdk";
import { resolveVoice, voiceCatalogue } from "./call-brief.js";
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
      hashtags: (p.hashtags ?? []).map(String).slice(0, 6),
      hookVariants: (p.hookVariants ?? [input.hook]).map(String).slice(0, 3),
      model: this.model,
    };
  }

  async suggestStoryTopics(input: SuggestTopicsInput): Promise<string[]> {
    // The old suggester hunted for "a specific dramatic true story" — a shallow
    // well that loops within a dozen presses. The reference-channel format is an
    // immersive SCENARIO ("Imagine you're a Roman soldier the night before a
    // battle…", "What happened if you got sick in the Middle Ages"), and that
    // space is enormous: era × aspect-of-life × frame. Sampling a few random
    // seeds each call spreads suggestions across it so they don't repeat.
    const eras = [
      "the Stone Age", "ancient Egypt", "ancient Rome", "ancient Greece", "the Viking age",
      "medieval Europe", "feudal Japan", "the Aztec empire", "the Ottoman empire", "Qing-dynasty China",
      "the Victorian era", "the American frontier (1800s)", "the age of sail", "WWII on the home front", "ancient Mesopotamia",
    ];
    const aspects = [
      "food and eating", "medicine and getting sick", "hygiene and the toilet", "death and burial", "war and battle",
      "love, sex and marriage", "money and trade", "crime and punishment", "work and a typical day", "childhood and school",
      "travel and navigation", "law and justice", "entertainment and games", "religion and the afterlife", "disease and plague",
    ];
    const pick = <T,>(a: T[], n: number) => [...a].sort(() => Math.random() - 0.5).slice(0, n);
    const seedEras = pick(eras, 4).join(", ");
    const seedAspects = pick(aspects, 5).join(", ");
    const avoidBlock = input.avoid?.length
      ? `\n\nDo NOT repeat or lightly reword any of these already-used ideas — go to a different era/aspect entirely:\n${input.avoid.map((t) => `- ${t}`).join("\n")}`
      : "";
    const result = await this.callTool<{ topics?: string[] }>(
      `Propose ${input.count} SCENARIO ideas for immersive, second-person history explainer videos${
        input.category ? ` for a "${input.category}" channel` : ""
      } — the kind that opens "Imagine you're a…" and reveals how something in the past actually was.

Each idea pairs an ERA with an ASPECT OF LIFE, framed as a curiosity that makes someone go "wait, really?". Good shapes: "A day in the life of [person in an era]", "What happened if you [did X] in [era]", "How people [did X] before [Y]", "What [aspect] was actually like in [era]".

For variety THIS time, lean on these eras — ${seedEras} — and these aspects — ${seedAspects} — but you may mix in others. Each idea 6-12 words, concrete and specific, no numbering.${avoidBlock}

Call submit_topics.`,
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
    return (result.topics ?? []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, input.count);
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

    // Mode-specific instructions injected into the two shared prompts below. Both
    // modes keep the same craft (cold open, concrete named detail, chaining, no
    // cringe closer); they differ in SHAPE — a scenario is an immersive walk
    // through how something WAS (escalating "wait, really?" reveals, no dramatic
    // twist required), a story is one specific event with a hook and a turn.
    const architectRole = isScenario
      ? `You are the SCENARIO ARCHITECT for an immersive, second-person history explainer (TikTok/Reels/Shorts/YouTube). The subject is: "${input.topic}".`
      : `You are the STORY ARCHITECT for a short-form (TikTok/Reels/Shorts) story video. The topic is: "${input.topic}".`;
    const architectStep1 = isScenario
      ? `STEP 1 — FRAME THE SCENARIO. "${input.topic}" is a window into how life actually was. Pick ONE concrete vantage point to live inside for the whole video — a specific person in a specific time and place (a Roman legionary the morning of battle; a servant in a Victorian townhouse; a child in a Stone-Age camp). Then list, in "angleOptions", 3 different vantage points you considered. The whole video walks through THIS scenario and keeps revealing surprising, concrete, TRUE detail — it does NOT need a dramatic twist; the payoff is accumulated "wait, that's how it really was?!" fascination.`
      : `STEP 1 — BRAINSTORM 3 ANGLES, THEN PICK ONE. A topic is not a story. Think of 3 genuinely DIFFERENT true story angles, each unmistakably about "${input.topic}" (different people / events / moments). Judge them on: strongest hook, clearest arc, a real TURN (a reversal, a "wait, what?"), and how squarely on-topic they are. Then pick the SINGLE best — an angle with no real turn is disqualified. List the 3 one-line angle premises you weighed in "angleOptions".`;
    const architectEnding = isScenario
      ? `4. "ending": the single most vivid or surprising concrete detail to CLOSE on — the last "huh, wild" beat, stated plainly. Not a moral, not a summary, not "and that's how it was" — just the strongest remaining detail, landed and done.`
      : `4. "ending": the story's REAL final fact or consequence — the last thing that actually happened, stated as plain fact. It must resolve the question the cold open raised, but it is NOT a punchline: no moral, no call-to-action, no rhetorical question, no crafted closing line.`;
    const architectSpineRoles = isScenario
      ? `   - "role": its job — hook / reveal / escalate / turn-of-the-screw / close.`
      : `   - "role": its job in the arc — hook / rehook / setup / rising / turn / payoff.`;
    const narratorFraming = isScenario
      ? `You are the NARRATOR of an immersive second-person history explainer about "${input.topic}". Put the viewer INSIDE the scenario ("you") and walk them through it, each beat revealing another concrete, surprising, TRUE detail of how it actually was. It does not need a plot twist — escalating fascination is the engine.`
      : `You are the NARRATOR. Turn this planned story about "${input.topic}" into finished spoken narration, beat by beat.`;

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

STAY ON TOPIC — this is non-negotiable. The finished video MUST be unmistakably about "${input.topic}". Someone who searched "${input.topic}" has to think "yes, this is exactly that", never "wait, why is this about something else".

${architectStep1}

Work only from what you actually know: real names, dates, places, numbers, the telling human detail. No vague filler, no "some say", no invented facts. Tone is PUNCHY BUT HONEST — the drama is allowed to be big, but every claim must be real and the hook must be a promise the ending truly keeps. Never over-promise.

Output:

0. "angleOptions": the 3 distinct ${isScenario ? "vantage points" : "true-story angles"} you considered (one line each), all on-topic for "${input.topic}".

1. "hookOptions": exactly 3 candidate opening lines for the CHOSEN angle. HARD RULE — every option MUST literally begin with one of these fixed stems (fill the brackets; the stem's opening words stay exactly as written):
   - "It's [date/year]. [A person] is [mid-action]…"  (e.g. "It's August 10th, 1998. A night guard in Stockholm is starting his last round.")
   - "In a small town in [country/region], [a person does one concrete thing]…"  (also fine: "In [year], in [place], …")
   - "Imagine [being in this exact situation]…"
   Openers sounding the same video to video is FINE — this is the format, consistency is a feature. Present tense, mid-scene, concrete.
   The first line NEVER announces or summarizes the story. BANNED first lines: "This is the story of…", "Did you know…", "The most X in history…", "Today…", introducing/naming the topic, or ANY line that gives away the premise. The viewer walks in on something already happening; the scene raises the question by itself.

2. "hook": the single STRONGEST of your 3 cold opens — the scene hardest to scroll away from, and one this true story can actually pay off. It MUST start with one of the stems above.

3. "setting": ONE compact line (comma-separated, ~30-45 words) of the CONCRETE, unmistakable visual markers of THIS story — real place, era, architecture, objects, clothing, weather, palette (for a Moscow story: "snowy Moscow, red-brick Kremlin walls, onion-domed cathedral, Cyrillic street signs, grey Soviet apartment blocks, fur ushanka hats and heavy coats, overcast winter sky"). If there's a main character, pin their FIXED look here ("recurring: a young man in a brown coat and grey ushanka"). Never generic — this anchors every frame.

${architectEnding}

5. "spine": the ordered beats — ${minBeats === maxBeats ? `EXACTLY ${maxBeats}` : `at least ${minBeats}, up to ${maxBeats}`}, one per key ${isScenario ? "moment of the scenario" : "story moment"}. Each beat has:
${architectSpineRoles}
   - "fact": the concrete real thing that happens in this beat, one line — and every fact NAMES its people and places outright (real names, dates, amounts): "Glyndwr Michael, a homeless Welshman, dies in London in January 1943", never "a man dies". No bare he/they/the man in a spine fact.
   KEEP THE CAST TIGHT: give NAMES only to the 1-3 people the story actually returns to, and the first fact that names someone must say who they are ("a British spy, Ewen Montagu"). Everyone who appears only once stays a role, never a name (a coroner, a fisherman) — a name the viewer meets once and never again just confuses.
   The spine is a CHAIN, not a list: each fact must follow causally from the one before (this happened, SO that happened). Structure it for retention: beat 1 = "hook" (the cold open above); an early "rehook" (~beat 2-3) that opens a second loop before curiosity dips; the stakes/tension RISE every beat with no flat middle; a clear "turn" around 60-70%; the LAST beat is "payoff" — the story's final real event, where the narration simply stops. NO wrap-up or resolution beat after it. Use only as many beats as the true story needs — don't pad.

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
      // Scales with the spine: 45+ beats of facts overflow a fixed 5000.
      Math.max(5000, maxBeats * 90 + 1500),
      // effort: "high" — the architect is the brain (story pick + arc + on-topic
      // faithfulness); reasoning here is where the quality gain lives.
      { model: this.commentaryModel, effort: "high" },
    );

    const spine = (outline.spine ?? [])
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
      script?: string;
      description?: string;
      hashtags?: string[];
      setting?: string;
      beats?: Array<{ text?: string; imagePrompt?: string; delivery?: string }>;
    }>(
      `${narratorFraming}

OPENING HOOK — beat 1's "text" MUST START with these exact words, and NOTHING may come before them (no topic introduction, no setup sentence, no title read-out): ${planHook || 'cold-open inside the scene, starting literally with "It\'s [date]…", "In a small town in…" or "Imagine…" — never announce what the story is about'}
VISUAL WORLD (setting): ${planSetting || "(derive a concrete, on-topic world)"}
STORY SPINE — follow this order, one beat each:
${spineText}
ENDING TO LAND ON: ${planEnding || "the story's real final consequence"}

HOW TO WRITE IT:
- Conversational, spoken aloud — contractions, varied sentence length, vivid concrete detail. No throat-clearing, no "in this video", no wiki-summary tone.
- Narrator persona: "${narrator}" — shape the emotional ARC to suit it (curiosity → tension → payoff), rising and falling, never flat. Tone is PUNCHY BUT HONEST: big drama, only real facts, never over-promise.
- LENGTH: the whole spoken narration must run BETWEEN ${minWords} and ${maxWords} words (~150 words/min, so roughly ${describeLength(minWords)}-${describeLength(maxWords)}). ${minWords} words is a FLOOR, not a suggestion — a story that lands short is not finished, so go back and give the setup and the turn the detail they deserve. Never pad with filler or repetition to reach it: earn the length with concrete specifics — names, dates, amounts, what someone actually said or did.

RETENTION MECHANICS (this is the job):
- COLD OPEN: the very FIRST WORDS of the whole narration are the opening hook above — starting "It's…", "In…" or "Imagine…". The viewer lands mid-scene (a date, a place, a person in motion), present tense. NEVER announce, name or summarize what the video is about before or after the hook's first line ("This is the story of…" is banned); the scene raises the question by itself.
- NAMES ANCHOR EVERYTHING: introduce the main character BY NAME within the first two beats and keep USING the names — people, places, dates, amounts, in almost every beat. Never chain pronouns across beats ("he… they… it…"); re-anchor with the name or clear role each beat so a viewer always knows WHO is doing WHAT, WHERE. Rich specifics are what make the story feel real and easy to follow.
- INTRODUCE EVERY NAMED PERSON ON FIRST MENTION: the first time a name appears, say in one clause WHO they are and why they matter ("a British spy named Ewen Montagu", "the town's coroner, Bentley Purchase") — never drop a bare surname the viewer has never met. And only NAME people the story comes back to; a one-off person who appears once is a role, not a name ("a fisherman", "a border guard"), so the cast stays small and nobody is confused by a name they can't place.
- CHAIN THE BEATS: every beat after the first OPENS by linking to the previous one ("So…", "That's when…", "Because of that…", "Three days later…") — one continuous told story, never a list of facts. Before submitting, read the whole narration start to finish and smooth ANY seam that feels like a jump; coherence beats cleverness.
- REHOOK: around the 2nd-3rd beat, open a SECOND smaller loop ("but that's not the strange part…") to catch anyone about to scroll before the curiosity dips.
- ESCALATE every beat — stakes, tension or weirdness rise, each beat pulling into the next; NO flat middle.

ENDING RULES (critical — this is what's been going wrong):
- The narration ends ON the story's final fact (the "ending" above): the LAST SENTENCE is simply the last thing that happened, stated plainly. Then it STOPS.
- NO END PUNCH of any kind: no punchline, kicker, button, callback line, clever flourish, or summary sentence. Do NOT "craft" a closing line at all — the final event IS the closing line. If it feels abrupt, that is correct.
- BANNED closers — NEVER end the narration with any of these: a call-to-action or "follow for more"/hashtag-speak; a tacked-on moral or life lesson; "let that sink in", "makes you wonder", "and the rest is history", "and that's the story of…", "mind = blown", "little did they know"; or a rhetorical question. The last line is part of the STORY, not a comment on it.

For EACH beat give:
- "text": the spoken narration (1-3 sentences — use the third when the beat needs its connective tissue or a telling detail).${
        input.voiceTags
          ? ` Embed 1-2 ElevenLabs audio tags inline where the read shifts (acted, not spoken): [pause], [whispers], [excited], [sighs], [laughs], [curious].`
          : ""
      }
- "imagePrompt": a concrete scene for THIS moment that LIVES INSIDE the setting — show WHERE we are with specific props/architecture/objects from the setting, never a figure in a blank void. The character is a SIMPLE STICK FIGURE, the SAME one every beat; capture their emotion/expression AND the action, e.g. "our stick figure with hands on his head in shock, on a snowy Moscow street with the Kremlin wall behind him". No text/letters in the image.
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
            script: { type: "string", description: "the full narration, all beats joined" },
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
          required: ["title", "script", "description", "hashtags", "setting", "beats"],
        },
      },
      // Scales with the script: a long-form narration plus a per-beat image
      // prompt and delivery note for 45+ beats runs well past a fixed 6000, and
      // overflowing truncates the tool call into an unusable partial story.
      Math.max(6000, Math.round(maxWords * 2.2) + maxBeats * 60 + 2000),
      // effort: "medium" — the narrator is execution (spine → coherent prose);
      // reasoning helps it chain beats without the cost of "high".
      { model: this.commentaryModel, effort: "medium" },
    );

    const cleanBeats = (result.beats ?? [])
      .filter((b) => String(b.text ?? "").trim() && String(b.imagePrompt ?? "").trim())
      .map((b) => ({
        text: String(b.text).trim(),
        imagePrompt: String(b.imagePrompt).trim(),
        ...(String(b.delivery ?? "").trim() ? { delivery: String(b.delivery).trim() } : {}),
      }));
    return {
      title: String(result.title ?? outline.title ?? input.topic).slice(0, 120),
      script: String(result.script ?? cleanBeats.map((b) => b.text).join(" ")),
      description: String(result.description ?? ""),
      hashtags: (result.hashtags ?? []).map(String).slice(0, 6),
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
      hashtags: (result.hashtags ?? []).map(String).slice(0, 6),
      shots,
    };
  }

  async expandImagePrompts(input: ExpandImagePromptsInput): Promise<string[][]> {
    if (input.beats.length === 0) return [];
    const listing = input.beats
      .map(
        (b, i) =>
          `${i + 1}. NARRATION: "${b.text}"\n   BASE IMAGE: ${b.imagePrompt}\n   SPLIT INTO: ${b.count} frames`,
      )
      .join("\n");

    const result = await this.callTool<{ beats?: Array<{ prompts?: string[] }> }>(
      `Each beat below stays on screen too long for a single picture. Cut it into the requested number of DISTINCT SHOTS — the way a video editor covers one moment from different angles — so the screen keeps changing and never looks like the same picture nudged.

WORLD (every shot lives here): ${input.setting || "unspecified"}

${listing}

Rules:
- The shots cover the SAME narration beat but from GENUINELY DIFFERENT compositions. Vary the shot type across them — e.g. a WIDE establishing shot of the whole scene, a TIGHT CLOSE-UP on the character's face showing the emotion, a DETAIL shot of the key object/action being described. Different framing, different subject, different distance — NOT the same image with a small change.
- They still read in order and stay true to the beat; do NOT invent new events the narration doesn't mention, and never jump ahead to a later beat.
- Each prompt stands alone (the image model sees only that one line) and must carry the world's concrete markers so the shots clearly belong to the same scene, and name the character's expression where a face is shown.
- Keep every subject centered and simply drawn; no on-screen text.
- Return exactly the requested number of prompts per beat, in the same beat order.
Call submit_frames.`,
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
      Math.max(3000, input.beats.reduce((n, b) => n + b.count, 0) * 60 + 1000),
    );

    // Pad/trim to exactly what was asked for: a short answer would silently
    // desync the slide list from the timing plan.
    return input.beats.map((b, i) => {
      const got = (result.beats?.[i]?.prompts ?? []).map(String).map((s) => s.trim()).filter(Boolean);
      const out: string[] = [];
      for (let k = 0; k < b.count; k++) out.push(got[k] ?? got[got.length - 1] ?? b.imagePrompt);
      return out;
    });
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
    const raw = (result.characters ?? []).slice(0, 2);
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
    const beats = (result.escalation ?? []).map(String).filter(Boolean).slice(0, 6);
    const escalation = beats.length > 0 ? beats : ["the call opens politely and steadily gets worse"];

    return {
      title: String(result.title ?? input.idea).slice(0, 120),
      description: String(result.description ?? ""),
      hashtags: (result.hashtags ?? []).map(String).slice(0, 6),
      premise: String(result.premise ?? input.idea),
      setup: String(result.setup ?? ""),
      characters,
      escalation,
      ragebait: (result.ragebait ?? []).map(String).filter(Boolean).slice(0, 5),
      ending: String(result.ending ?? ""),
      durationSeconds: seconds,
      direction: String(result.direction ?? ""),
      imagePrompts: (result.imagePrompts ?? []).map(String).filter(Boolean).slice(0, 4),
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
