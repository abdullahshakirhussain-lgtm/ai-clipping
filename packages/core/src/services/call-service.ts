import { buildCallBrief, type LlmProvider } from "@clipfactory/ai";
import type { Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { CallPlanDto, CallSpecDto, CreateCallInput } from "../contracts/calls.js";

/** Call spec persisted on the SourceVideo (kind=call) and read by the generator. */
export interface CallSpec extends CallSpecDto {
  /** The APPROVED brief — sent to the audio model verbatim. */
  brief: string;
  category?: string;
  captionStyle?: string;
  captionPosition?: "top" | "middle" | "bottom";
  /** Filled in by the job once the dialogue has been improvised (viewable after). */
  transcript?: string;
}

/**
 * Call Studio: fictional prank-call / talk-show rage bait, two-step so nothing
 * is spent on an unvetted brief. `plan` writes the whole brief from a one-line
 * idea (cheap text); `create` sends the approved brief for audio. Mirrors
 * CookService for the create → SourceVideo → job → Clip machinery.
 */
export class CallService {
  constructor(
    private readonly repos: Repositories,
    private readonly llm: LlmProvider,
    private readonly dispatcher: Dispatcher,
    private readonly maxSeconds: number,
  ) {}

  /** Step 1: idea → editable brief. No audio spend. */
  async plan(idea: string): Promise<CallPlanDto> {
    const plan = await this.llm.planCall({ idea: idea.trim(), maxSeconds: this.maxSeconds });
    return { ...plan, brief: buildCallBrief(plan) };
  }

  /**
   * Step 1b: re-assemble the brief from edited fields. Same function the job
   * would use, so the preview is exactly what gets sent.
   */
  preview(spec: CallSpecDto): { brief: string } {
    return { brief: buildCallBrief(spec) };
  }

  /** Step 2: generate the video from the approved brief. */
  async create(input: CreateCallInput): Promise<{ sourceVideoId: string }> {
    const campaignId = await this.getOrCreateCallCampaignId();
    const spec: CallSpec = {
      ...input,
      category: input.category?.trim() || undefined,
      title: input.title.trim() || input.premise.slice(0, 80),
    };
    const video = await this.repos.sourceVideos.create({
      campaignId,
      originalUrl: null,
      title: spec.title.slice(0, 120),
      status: "PENDING",
      kind: "call",
      storySpec: spec as never,
      category: spec.category ?? null,
      commentaryMode: "off",
      ...(spec.captionStyle ? { captionStyle: spec.captionStyle } : {}),
      ...(spec.captionPosition ? { captionPosition: spec.captionPosition } : {}),
    });
    await this.dispatcher.enqueue("call.generate", { sourceVideoId: video.id }, { jobId: video.id });
    return { sourceVideoId: video.id };
  }

  /** A dedicated campaign so calls group separately from stories/cooks/uploads. */
  private async getOrCreateCallCampaignId(): Promise<string> {
    const existing = await this.repos.campaigns.list();
    const found = existing.find((c) => c.name === "Call Studio");
    if (found) return found.id;
    const created = await this.repos.campaigns.create({
      name: "Call Studio",
      allowedPlatforms: ["YOUTUBE", "TIKTOK", "INSTAGRAM"],
      status: "ACTIVE",
    });
    return created.id;
  }
}
