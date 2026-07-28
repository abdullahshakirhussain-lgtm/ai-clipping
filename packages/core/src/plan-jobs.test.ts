import { describe, expect, it } from "vitest";
import { PlanJobs } from "./services/plan-jobs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("PlanJobs", () => {
  it("returns a token immediately instead of holding the caller for the whole plan", async () => {
    const jobs = new PlanJobs();
    const started = Date.now();
    const { planId } = jobs.start("cook", async () => {
      await sleep(300);
      return { shots: [{ prompt: "one" }] };
    });
    // The point of the whole mechanism: the POST returns in milliseconds, so no
    // proxy sits waiting on a multi-minute reasoning call and hangs up (499).
    expect(Date.now() - started).toBeLessThan(100);
    expect(jobs.get(planId)?.status).toBe("pending");

    await sleep(450);
    const done = jobs.get<{ shots: unknown[] }>(planId);
    expect(done?.status).toBe("done");
    expect(done?.result?.shots).toHaveLength(1);
    expect(done?.elapsedMs).toBeGreaterThanOrEqual(250);
  });

  it("captures a planner failure as a terminal error rather than an unhandled rejection", async () => {
    const jobs = new PlanJobs();
    const { planId } = jobs.start("call", async () => {
      await sleep(10);
      throw new Error("model refused");
    });
    await sleep(120);
    expect(jobs.get(planId)?.status).toBe("error");
    expect(jobs.get(planId)?.error).toBe("model refused");
  });

  it("reports an unknown id as missing so the poller can stop", () => {
    expect(new PlanJobs().get("nope")).toBeNull();
  });

  it("keeps concurrent plans separate", async () => {
    const jobs = new PlanJobs();
    const a = jobs.start("cook", async () => {
      await sleep(80);
      return "A";
    });
    const b = jobs.start("call", async () => {
      await sleep(10);
      return "B";
    });
    expect(a.planId).not.toBe(b.planId);
    await sleep(200);
    expect(jobs.get<string>(a.planId)?.result).toBe("A");
    expect(jobs.get<string>(b.planId)?.result).toBe("B");
  });
});
