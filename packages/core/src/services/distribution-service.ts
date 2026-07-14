import { PublishJobStatus, type Repositories } from "@clipfactory/db";
import type { PublishJobDetail } from "@clipfactory/db";
import type { ObjectStorage } from "@clipfactory/storage";
import type {
  DistributeResult,
  DistributionOverview,
  PostTask,
} from "../contracts/index.js";
import { NotFoundError } from "../errors.js";
import { computeSlots } from "../scheduling.js";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Routes kept+approved clips to same-category accounts (cross-post to each
 * platform), auto-schedules them by each account's cadence, and drives the
 * manual (VA) posting workflow. It never calls a platform API — jobs are
 * post-tasks a person (or an exported scheduler) fulfils.
 */
export class DistributionService {
  constructor(
    private readonly repos: Repositories,
    private readonly storage: ObjectStorage,
  ) {}

  /** Create scheduled post-tasks for every distributable clip × its category accounts. */
  async distribute(clipIds?: string[]): Promise<DistributeResult> {
    const [clips, accounts] = await Promise.all([
      this.repos.clips.distributable(clipIds),
      this.repos.socialAccounts.list(),
    ]);
    const active = accounts.filter((a) => a.status === "ACTIVE");
    const byCategory = new Map<string, typeof active>();
    for (const a of active) {
      if (!byCategory.has(a.category)) byCategory.set(a.category, []);
      byCategory.get(a.category)!.push(a);
    }

    // Which new (clip → account) pairs need creating, grouped per account, plus
    // why any clip produced no jobs so the UI can explain the outcome.
    const skipped = { noCategory: 0, noMatchingAccount: 0, alreadyDistributed: 0 };
    const perAccount = new Map<string, string[]>();
    for (const clip of clips) {
      if (!clip.category) {
        skipped.noCategory++;
        continue;
      }
      const accts = byCategory.get(clip.category) ?? [];
      if (accts.length === 0) {
        skipped.noMatchingAccount++;
        continue;
      }
      const existing = new Set(clip.publishJobs.map((j) => j.socialAccountId));
      const newAccts = accts.filter((a) => !existing.has(a.id));
      if (newAccts.length === 0) {
        skipped.alreadyDistributed++;
        continue;
      }
      for (const a of newAccts) {
        if (!perAccount.has(a.id)) perAccount.set(a.id, []);
        perAccount.get(a.id)!.push(clip.id);
      }
    }

    let jobsCreated = 0;
    const byAccount: DistributeResult["byAccount"] = [];
    for (const [accountId, clipIds] of perAccount) {
      const account = active.find((a) => a.id === accountId)!;
      const taken = await this.repos.publish.scheduledTimesForAccount(accountId);
      const slots = computeSlots({
        timezone: account.timezone,
        postsPerDay: account.postsPerDay,
        activeStartHour: account.activeStartHour,
        activeEndHour: account.activeEndHour,
        taken,
        count: clipIds.length,
      });
      await this.repos.publish.createJobs(
        clipIds.map((clipId, i) => ({
          clipId,
          socialAccountId: accountId,
          scheduledAt: slots[i] ?? null,
          status: PublishJobStatus.SCHEDULED,
        })),
      );
      jobsCreated += clipIds.length;
      byAccount.push({
        accountId,
        handle: account.handle,
        platform: account.platform,
        created: clipIds.length,
      });
    }
    return { clipsConsidered: clips.length, jobsCreated, byAccount, skipped };
  }

  /** The VA board for one account: pending posts, soonest first. */
  async queue(accountId: string): Promise<PostTask[]> {
    const jobs = await this.repos.publish.forAccount(accountId, [PublishJobStatus.SCHEDULED]);
    return Promise.all(jobs.map((j) => this.toPostTask(j)));
  }

  async overview(): Promise<DistributionOverview> {
    const [accounts, postedRows, pendingRows] = await Promise.all([
      this.repos.socialAccounts.list(),
      this.repos.publish.publishedCountsByAccount(startOfToday()),
      this.repos.publish.pendingCountsByAccount(),
    ]);
    const posted = new Map(postedRows.map((r) => [r.socialAccountId, r.count]));
    const pending = new Map(pendingRows.map((r) => [r.socialAccountId, r.count]));
    const rows = accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      handle: a.handle,
      category: a.category,
      postsPerDay: a.postsPerDay,
      postedToday: posted.get(a.id) ?? 0,
      scheduledPending: pending.get(a.id) ?? 0,
    }));
    return {
      accounts: rows,
      totals: {
        postedToday: rows.reduce((n, r) => n + r.postedToday, 0),
        scheduledPending: rows.reduce((n, r) => n + r.scheduledPending, 0),
      },
    };
  }

  async markPosted(jobId: string, url: string): Promise<PostTask> {
    await this.getJob(jobId);
    const updated = await this.repos.publish.update(jobId, {
      status: PublishJobStatus.PUBLISHED,
      externalUrl: url,
      publishedAt: new Date(),
    });
    return this.toPostTask(updated);
  }

  async skip(jobId: string): Promise<PostTask> {
    await this.getJob(jobId);
    const updated = await this.repos.publish.update(jobId, { status: PublishJobStatus.CANCELLED });
    return this.toPostTask(updated);
  }

  async reschedule(jobId: string, scheduledAt: string): Promise<PostTask> {
    await this.getJob(jobId);
    const updated = await this.repos.publish.update(jobId, { scheduledAt: new Date(scheduledAt) });
    return this.toPostTask(updated);
  }

  private async getJob(id: string): Promise<PublishJobDetail> {
    const job = await this.repos.publish.byId(id);
    if (!job) throw new NotFoundError("PublishJob", id);
    return job;
  }

  private async toPostTask(job: PublishJobDetail): Promise<PostTask> {
    const enh = job.clip.enhancement;
    const [previewUrl, thumbnailUrl] = await Promise.all([
      job.clip.storageKey ? this.storage.getUrl(job.clip.storageKey) : Promise.resolve(null),
      job.clip.thumbnailKey ? this.storage.getUrl(job.clip.thumbnailKey) : Promise.resolve(null),
    ]);
    return {
      jobId: job.id,
      clipId: job.clipId,
      accountId: job.socialAccountId,
      platform: job.socialAccount.platform,
      handle: job.socialAccount.handle,
      category: job.clip.category ?? null,
      scheduledAt: job.scheduledAt ? job.scheduledAt.toISOString() : null,
      status: job.status,
      title: enh?.title ?? null,
      description: enh?.description ?? null,
      hashtags: enh?.hashtags ?? [],
      previewUrl,
      thumbnailUrl,
      externalUrl: job.externalUrl,
    };
  }
}
