import Anthropic from "@anthropic-ai/sdk";
import { planVisionBatches } from "./types.js";
import type {
  ClipSignals,
  CommentaryIntensity,
  CommentaryLine,
  CommentaryRole,
  DescribeVideoContextInput,
  DetectHighlightsInput,
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
    opts?: { model?: string; temperature?: number },
  ): Promise<T> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: opts?.model ?? this.model,
      max_tokens: maxTokens,
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
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
    const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!block) throw new Error("Claude did not return the expected tool call");
    return block.input as T;
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
    const result = await this.callTool<{ topics?: string[] }>(
      `Propose ${input.count} short-form video story topics that would genuinely stop a scroll${
        input.category ? ` for a "${input.category}" channel` : ""
      }. Each is a specific, surprising, TRUE-leaning story hook — a person, event, scam, discovery, or "wait, that really happened?" moment — not a broad theme. 6-12 words each. No numbering. Call submit_topics.`,
      {
        name: "submit_topics",
        description: "Submit candidate story topics.",
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
    const maxBeats = Math.max(5, Math.min(20, input.maxBeats));
    const maxWords = Math.max(120, Math.min(400, input.maxWords));
    const narrator = input.narrator ?? "storyteller";
    const result = await this.callTool<{
      title?: string;
      script?: string;
      description?: string;
      hashtags?: string[];
      setting?: string;
      beats?: Array<{ text?: string; imagePrompt?: string; delivery?: string }>;
    }>(
      `Write a narrated STORY about: "${input.topic}".

YOUR #1 JOB: a COMPLETE, genuinely interesting story that makes someone watch to the very END. A full arc that lands — completeness and intrigue beat everything else. Read aloud as one continuous narration:
- HOOK (first 1-2 lines): the single most surprising, scroll-stopping opener — a shocking fact, a "wait, what?", a question. Earn the first 3 seconds or nothing else matters.
- BODY: actually TELL the story — real specifics (names, numbers, places, the telling detail), rising stakes, each beat pulling to the next.
- ENDING: a clean, satisfying resolution — the payoff/twist lands, then ONE closing line that feels finished (not an abrupt stop, not a hard sell).

LENGTH — the story decides, with one cap: keep the spoken narration UNDER 2 minutes (~${maxWords} words absolute maximum, ~150 words/minute). SHORTER is better whenever the story is best told tight — never pad to fill time, and never rush or cut the arc to save it. If a topic genuinely can't be told well under 2 minutes, tell the most complete TIGHTER version instead of a truncated long one.

Conversational, spoken aloud — contractions, varied sentence length, vivid concrete detail. No throat-clearing, no "in this video", no wiki-summary tone. Narrator persona: "${narrator}" — write the emotional ARC to suit it (curiosity → tension → payoff), rising and falling, never flat.

FIRST lock the story's VISUAL WORLD — "setting": ONE compact line (comma-separated, ~30-45 words) of the CONCRETE, unmistakable visual markers of THIS topic, so every frame reads as one coherent place a viewer can picture themselves in. Name the real place, era, architecture, objects, clothing, weather, palette — the specific stuff (for Russia: "snowy Moscow, red-brick Kremlin walls, onion-domed cathedral, Cyrillic street signs, grey Soviet apartment blocks, people in fur ushanka hats and heavy coats, overcast winter sky"). If the story has a main character, pin their FIXED look here ("recurring: a young man in a brown coat and grey ushanka") so they stay the SAME person every frame. Never generic — this is the anchor that makes the whole video feel on-topic.

Break it into beats — one image on screen while its lines are read. Use as MANY beats as the story needs (roughly one image per 1-2 sentences), minimum 5, maximum ${maxBeats}. Don't stretch or cram to hit a number. Each beat:
- "text": the spoken narration for this beat (1-2 sentences).${
        input.voiceTags
          ? ` Embed 1-2 ElevenLabs audio tags inline where the read shifts (acted, not spoken): [pause], [whispers], [excited], [sighs], [laughs], [curious].`
          : ""
      }
- "imagePrompt": a concrete scene for THIS moment that LIVES INSIDE the setting above — show WHERE we are with specific environmental detail (the place, props, architecture, objects from the setting), not a figure in a blank void. Reuse the SAME recurring character (describe them consistently). Capture their EMOTION/expression AND the action, e.g. "our young man in his grey ushanka, hands on his head in shock, on a snowy Moscow street with the Kremlin wall behind him". One clear subject, but ALWAYS anchored in the world. No text/letters in the image.
- "delivery": 1-2 sentences on the emotion of this beat (feeds the read's arc).

Also give a title, a 1-2 sentence description with a soft CTA, and up to 6 hashtags.
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
                  imagePrompt: { type: "string", description: "simple scene to draw for this beat" },
                  delivery: { type: "string", description: "how to read this beat: pace, pitch, emotion" },
                },
                required: ["text", "imagePrompt", "delivery"],
              },
            },
          },
          required: ["title", "script", "description", "hashtags", "setting", "beats"],
        },
      },
      3072,
      { model: this.commentaryModel, temperature: 0.9 },
    );

    const cleanBeats = (result.beats ?? [])
      .filter((b) => String(b.text ?? "").trim() && String(b.imagePrompt ?? "").trim())
      .map((b) => ({
        text: String(b.text).trim(),
        imagePrompt: String(b.imagePrompt).trim(),
        ...(String(b.delivery ?? "").trim() ? { delivery: String(b.delivery).trim() } : {}),
      }));
    return {
      title: String(result.title ?? input.topic).slice(0, 120),
      script: String(result.script ?? cleanBeats.map((b) => b.text).join(" ")),
      description: String(result.description ?? ""),
      hashtags: (result.hashtags ?? []).map(String).slice(0, 6),
      setting: String(result.setting ?? "").trim(),
      beats: cleanBeats,
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
