import type { Logger } from "../logger.js";

export interface PlanJobState<T> {
  status: "pending" | "done" | "error";
  result?: T;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** How long a finished plan stays fetchable before it's swept. */
const TTL_MS = 30 * 60 * 1000;

/**
 * Runs the Studio planners in the BACKGROUND and hands the caller a poll token.
 *
 * The planners are a single high-effort reasoning call (2-5 minutes is normal
 * for a good shot list or call brief), and a request held open that long dies
 * somewhere between the browser, the Next proxy and the API — which is what the
 * 499s were: a proxy hanging up before the model finished, with no way for the
 * user to tell a slow plan from a broken one.
 *
 * Deliberately in-process and in-memory: a plan is a transient that lives for a
 * couple of minutes, so a table + migration would be ceremony. The trade-off is
 * that an API restart drops in-flight plans (the user re-plans) and that polling
 * assumes ONE API instance — true on Railway today; if this ever runs multiple
 * replicas, the store has to move to Redis or the DB.
 */
export class PlanJobs {
  private readonly jobs = new Map<string, PlanJobState<unknown>>();

  constructor(private readonly logger?: Logger) {}

  /** Kick off `fn`, return the id to poll. Never throws — failures land on the job. */
  start<T>(label: string, fn: () => Promise<T>): { planId: string } {
    this.sweep();
    const planId = `${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const job: PlanJobState<T> = { status: "pending", startedAt: Date.now() };
    this.jobs.set(planId, job as PlanJobState<unknown>);

    void fn()
      .then((result) => {
        job.status = "done";
        job.result = result;
        job.finishedAt = Date.now();
        this.logger?.info({ planId, label, ms: job.finishedAt - job.startedAt }, "plan ready");
      })
      .catch((err: unknown) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = Date.now();
        this.logger?.warn(
          { planId, label, ms: job.finishedAt - job.startedAt, reason: job.error },
          "plan failed",
        );
      });

    return { planId };
  }

  get<T>(planId: string): (PlanJobState<T> & { elapsedMs: number }) | null {
    const job = this.jobs.get(planId) as PlanJobState<T> | undefined;
    if (!job) return null;
    return { ...job, elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt };
  }

  /** Drop finished jobs past their TTL so a long-lived process doesn't grow. */
  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== "pending" && (job.finishedAt ?? job.startedAt) < cutoff) this.jobs.delete(id);
    }
  }
}
