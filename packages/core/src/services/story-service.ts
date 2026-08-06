import type { Repositories } from "@clipfactory/db";
import type { CheapTextProvider, LlmProvider } from "@clipfactory/ai";
import type { Dispatcher } from "@clipfactory/queue";
import type { CreateStoryInput } from "../contracts/story.js";

/** Reject if `p` hasn't settled within `ms` — so a slow model call can't hang an
 *  interactive request past the proxy's ~30s cutoff. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Plainly-worded day-in-the-life ideas, used only when every model call fails or
 *  times out, so the Suggest button always returns a usable list. */
const FALLBACK_TOPICS = [
  "A day in the life of a medieval baker",
  "What a school day was like 300 years ago",
  "How people kept food from spoiling before fridges",
  "A day working down a Victorian coal mine",
  "What you ate on a sailing ship crossing the ocean",
  "How people told the time before clocks",
  "A day in the life of a Roman soldier on the wall",
  "What happened when you got a toothache in the 1700s",
  "How a farming family got through a winter day",
  "A day in the life of a lighthouse keeper",
  "What washing day was like before machines",
  "A market trader's day in an ancient city",
];
function pickFallbackTopics(n: number): string[] {
  return [...FALLBACK_TOPICS].sort(() => Math.random() - 0.5).slice(0, n);
}

/**
 * Everything that differs between a long-form 16:9 explainer and a vertical
 * Short. `length` is the single knob the user picks; these are the derived shape.
 *
 * LONG is the ~8-minute format: at ~150 wpm that's ~1200 words (band 1050-1300).
 * Each beat is cut into up to three distinct shots (see planImageCadence), so
 * ~50-60 beats ≈ a new picture every ~3s — a swipe-feed pace, not the old ~10s
 * hold. Narration this long exceeds a single TTS request, so it's synthesized in
 * sentence-aligned chunks and joined (narration.ts). SHORT is a 9:16 clip of
 * ~90s-2.5min (200-360 words, up to ~32 beats), comfortably over the 60s line.
 *
 * The word FLOOR matters as much as the ceiling: the writer is otherwise told
 * shorter is better and hands back a stub.
 */
export type StoryLength = "long" | "short";

export interface LengthPreset {
  aspect: "16:9" | "9:16";
  /** OpenAI image size matching the aspect (landscape 3:2 vs portrait 2:3). */
  imageSize: string;
  maxBeats: number;
  /** FLOOR on beats — the real driver of image count (each beat splits into ≤3
   *  stills), so long form MUST demand many beats or it lands at ~36 images. */
  minBeats: number;
  minWords: number;
  maxWords: number;
}

/** `long`'s maxBeats is filled from the env cap at construction (see below). */
export function lengthPreset(length: StoryLength, longMaxBeats: number): LengthPreset {
  // SHORT is the default we publish. It must stay UNDER YouTube's 3-minute Shorts
  // cap, and the writer kept ignoring the word ceiling to narrate a whole day — so
  // the real bound is the BEAT COUNT (one narration chunk per beat). maxBeats 18 ×
  // ~one short sentence each keeps it ≈2-2.5 min even if the writer runs full; the
  // 240-360 word band is the secondary guard. The writer is told to preserve the
  // waking open + sleep close and compress the middle to a few moments.
  //
  // LONG must earn ~150 images: with ≤3 stills per beat that needs ~45+ beats, so
  // minBeats is set high (just under the maxBeats cap) — the missing floor was why
  // long form kept landing at ~36 images.
  return length === "short"
    ? { aspect: "9:16", imageSize: "1024x1536", maxBeats: 18, minBeats: 10, minWords: 240, maxWords: 360 }
    : { aspect: "16:9", imageSize: "1536x1024", maxBeats: longMaxBeats, minBeats: Math.min(44, longMaxBeats - 2), minWords: 1050, maxWords: 1300 };
}

/** Story spec persisted on the SourceVideo (kind=story) and read by the generator. */
export interface StorySpec {
  topic: string;
  /** "scenario" (immersive explainer, default) or "story" (dramatic true story). */
  mode: "scenario" | "story";
  length: StoryLength;
  /** "16:9" (long) or "9:16" (short) — drives image, assembly and caption canvas. */
  aspect: "16:9" | "9:16";
  /** OpenAI image size matching the aspect. */
  imageSize: string;
  style: string;
  narrator: string;
  /** Ceiling on beats — the writer uses as many as the story needs. */
  maxBeats: number;
  /** Beat FLOOR — the real driver of image count (long form demands many beats). */
  minBeats?: number;
  maxWords: number;
  /** Word FLOOR, so the narration clears the 60-second line. */
  minWords?: number;
  category?: string;
  captionStyle: string;
  captionPosition: "top" | "middle" | "bottom";
}

/**
 * Story Studio: kicks off AI-generated narrated slideshow videos. Creates a
 * SourceVideo (kind=story) so the job shows in the Video Queue and the finished
 * video lands in the Library like any clip.
 */
export class StoryService {
  /** Suggestions run on the cheap provider (DeepSeek) when configured; falls back
   *  to the main LLM when `cheapText` is omitted. */
  private readonly cheapText: CheapTextProvider;

  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmProvider,
    private readonly dispatcher: Dispatcher,
    private readonly maxBeats: number,
    cheapText?: CheapTextProvider,
  ) {
    this.cheapText = cheapText ?? llm;
  }

  async suggestTopics(category?: string): Promise<string[]> {
    // This is an interactive button behind a proxy that hangs up at ~30s, and any
    // model call CAN spike past that. So the whole thing runs under a hard deadline
    // and ALWAYS returns something: cheap provider → main LLM → canned topics.
    const work = (async () => {
      // Pass the recently-used topics so the model doesn't keep proposing the same
      // handful — the repetition the user hit came from sending no history at all.
      const recent = await this.repos.sourceVideos.list();
      const avoid = recent
        .filter((v) => v.kind === "story")
        .map((v) => v.title)
        .filter((t): t is string => !!t)
        .slice(0, 20);
      const req = { category, count: 8, avoid };
      try {
        return await this.cheapText.suggestStoryTopics(req);
      } catch {
        // Cheap provider (DeepSeek) slow/unreachable — fall back to the main LLM,
        // unless it IS the main LLM (no separate cheap provider configured).
        if (this.cheapText === this.llm) throw new Error("cheap provider failed");
        return this.llm.suggestStoryTopics(req);
      }
    })();

    try {
      return await withDeadline(work, 18000);
    } catch {
      // Never leave the button spinning to the proxy timeout — hand back a varied
      // set of plainly-worded day-in-the-life ideas the user can pick from.
      return pickFallbackTopics(8);
    }
  }

  async create(input: CreateStoryInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateStoryCampaignId();
    const preset = lengthPreset(input.length, this.maxBeats);
    const spec: StorySpec = {
      topic: input.topic.trim(),
      mode: input.mode,
      length: input.length,
      aspect: preset.aspect,
      imageSize: preset.imageSize,
      style: input.style,
      narrator: input.narrator,
      maxBeats: preset.maxBeats,
      minBeats: preset.minBeats,
      maxWords: preset.maxWords,
      minWords: preset.minWords,
      category: input.category?.trim() || undefined,
      captionStyle: input.captionStyle,
      captionPosition: input.captionPosition,
    };
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: input.topic.trim().slice(0, 120),
      status: "PENDING",
      kind: "story",
      storySpec: spec as never,
      category: spec.category ?? null,
      // Stories carry their own captions/voice; the clip render path is skipped.
      commentaryMode: "off",
    });
    await this.dispatcher.enqueue("story.generate", { sourceVideoId: video.id }, { jobId: video.id });
    return { sourceVideoId: video.id };
  }

  /** A dedicated campaign so generated videos group separately from uploads. */
  private async getOrCreateStoryCampaignId(): Promise<string> {
    const existing = await this.repos.campaigns.list();
    const found = existing.find((c) => c.name === "Story Studio");
    if (found) return found.id;
    const created = await this.repos.campaigns.create({
      name: "Story Studio",
      allowedPlatforms: ["YOUTUBE", "TIKTOK", "INSTAGRAM"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
