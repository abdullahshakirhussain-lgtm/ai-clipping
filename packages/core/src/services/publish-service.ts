import { ClipStatus, PublishJobStatus, type Repositories } from "@clipfactory/db";
import type { Dispatcher } from "@clipfactory/queue";
import type { PublishJobDto, PublishRequest } from "../contracts/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { toPublishJobDto } from "../mappers.js";

export class PublishService {
  constructor(
    private readonly repos: Repositories,
    private readonly dispatcher: Dispatcher,
  ) {}

  /** Creates one publish job per target account for an approved clip. */
  async publishClip(clipId: string, input: PublishRequest): Promise<PublishJobDto[]> {
    const clip = await this.repos.clips.byId(clipId);
    if (!clip) throw new NotFoundError("Clip", clipId);
    if (clip.status !== ClipStatus.APPROVED && clip.status !== ClipStatus.PUBLISHED) {
      throw new ConflictError(`Clip must be APPROVED to publish (is ${clip.status})`);
    }

    const accounts = await this.repos.socialAccounts.byIds(input.accountIds);
    if (accounts.length !== input.accountIds.length) {
      throw new ValidationError("One or more accountIds do not exist");
    }
    const allowed = new Set(clip.campaign.allowedPlatforms);
    for (const a of accounts) {
      if (!allowed.has(a.platform)) {
        throw new ValidationError(
          `Account ${a.handle} is on ${a.platform}, not allowed by this campaign`,
        );
      }
    }

    const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const isScheduled = scheduledAt !== null && scheduledAt.getTime() > Date.now();

    const jobs = await this.repos.publish.createJobs(
      accounts.map((a) => ({
        clipId,
        socialAccountId: a.id,
        scheduledAt,
        status: isScheduled ? PublishJobStatus.SCHEDULED : PublishJobStatus.QUEUED,
      })),
    );

    await this.repos.clips.update(clipId, {
      status: isScheduled ? ClipStatus.SCHEDULED : ClipStatus.PUBLISHING,
    });

    for (const job of jobs) {
      await this.dispatcher.enqueue(
        "publish.execute",
        { publishJobId: job.id },
        {
          jobId: job.id,
          delayMs: isScheduled ? Math.max(0, scheduledAt!.getTime() - Date.now()) : 0,
        },
      );
    }
    return jobs.map(toPublishJobDto);
  }

  async list(filter?: { status?: PublishJobStatus; clipId?: string }): Promise<PublishJobDto[]> {
    const rows = await this.repos.publish.list(filter);
    return rows.map(toPublishJobDto);
  }

  async get(id: string): Promise<PublishJobDto> {
    const job = await this.repos.publish.byId(id);
    if (!job) throw new NotFoundError("PublishJob", id);
    return toPublishJobDto(job);
  }

  async retry(id: string): Promise<PublishJobDto> {
    const job = await this.repos.publish.byId(id);
    if (!job) throw new NotFoundError("PublishJob", id);
    if (job.status !== PublishJobStatus.FAILED) {
      throw new ConflictError(`Only FAILED jobs can be retried (is ${job.status})`);
    }
    await this.repos.publish.update(id, { status: PublishJobStatus.QUEUED, lastError: null });
    await this.dispatcher.enqueue("publish.execute", { publishJobId: id });
    return this.get(id);
  }

  async cancel(id: string): Promise<PublishJobDto> {
    const job = await this.repos.publish.byId(id);
    if (!job) throw new NotFoundError("PublishJob", id);
    const cancellable: PublishJobStatus[] = [PublishJobStatus.QUEUED, PublishJobStatus.SCHEDULED];
    if (!cancellable.includes(job.status)) {
      throw new ConflictError(`Cannot cancel a job that is ${job.status}`);
    }
    await this.repos.publish.update(id, { status: PublishJobStatus.CANCELLED });
    return this.get(id);
  }
}
