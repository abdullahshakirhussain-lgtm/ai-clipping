import { GoogleVeoProvider, retryAfterMs, unsupportedField } from "@clipfactory/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These cover the two ways a Veo run has actually failed in production:
 * an unsupported field the strip-and-retry didn't recognise (which cost 8 of 9
 * shots in one run), and rate limits, which had no handling at all.
 */
const realFetch = globalThis.fetch;

interface Sent {
  url: string;
  instance: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

/** Stub the API. `rejectStart` returns a 400 body, or null to accept. */
function stubVeo(opts: {
  rejectStart?: (s: Sent) => string | null;
  startStatus?: () => { status: number; retryAfter?: string } | null;
  pollStatus?: () => { status: number; retryAfter?: string } | null;
}) {
  const sent: Sent[] = [];
  let polls = 0;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes(":predictLongRunning")) {
      const body = JSON.parse(init!.body!);
      sent.push({ url: u, instance: body.instances[0], parameters: body.parameters });
      const limited = opts.startStatus?.();
      if (limited) {
        return {
          ok: false,
          status: limited.status,
          headers: { get: (h: string) => (h === "retry-after" ? (limited.retryAfter ?? null) : null) },
          text: async () => "rate limited",
        };
      }
      const bad = opts.rejectStart?.(sent[sent.length - 1]!);
      if (bad) {
        return {
          ok: false,
          status: 400,
          headers: { get: () => null },
          text: async () => JSON.stringify({ error: { message: bad } }),
        };
      }
      return { ok: true, headers: { get: () => null }, json: async () => ({ name: "operations/x" }) };
    }
    polls++;
    const limited = opts.pollStatus?.();
    if (limited) {
      return {
        ok: false,
        status: limited.status,
        headers: { get: (h: string) => (h === "retry-after" ? (limited.retryAfter ?? null) : null) },
        text: async () => "rate limited",
      };
    }
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        done: true,
        response: { generatedVideos: [{ video: { bytesBase64Encoded: Buffer.from("MP4").toString("base64") } }] },
      }),
    };
  }) as never;
  return { sent, pollCount: () => polls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

/**
 * The provider sleeps between polls and between rate-limit retries — 8s+ of
 * wall clock per call. Drive those with fake timers so the suite stays fast:
 * `runAllTimersAsync` keeps firing timers (and flushing the promise chain
 * between them) until none are left, which covers the timers each iteration
 * schedules as it goes.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  const drained = p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
  await vi.runAllTimersAsync();
  const r = await drained;
  if (!r.ok) throw r.e;
  return r.v;
}

describe("unsupportedField", () => {
  it("matches the singular form Google uses for a backticked parameter", () => {
    expect(unsupportedField("`negativePrompt` isn't supported by this model.")).toBe("negativePrompt");
  });

  it("matches the PLURAL form that went unhandled and cost 8 of 9 shots", () => {
    expect(unsupportedField("Reference images are not supported for this model.")).toBe("images");
  });

  it("prefers the backticked field name anywhere in the message", () => {
    expect(unsupportedField("The field `referenceImages` is not supported on veo-3.1-lite.")).toBe("referenceImages");
  });

  it("reads the field out of the real JSON envelope, not the JSON's own keys", () => {
    // Matching any quote style picks up "error"/"message" first — which is
    // exactly how a strip silently stopped working.
    const body = JSON.stringify({ error: { code: 400, message: "`negativePrompt` isn't supported by this model." } });
    expect(unsupportedField(body)).toBe("negativePrompt");
  });

  it("ignores errors that aren't about an unsupported field", () => {
    expect(unsupportedField("Billing has not been enabled for this project.")).toBeNull();
    expect(unsupportedField("Quota exceeded.")).toBeNull();
  });
});

describe("retryAfterMs", () => {
  const hdr = (v: string | null) => ({ get: () => v });

  it("honours the server's Retry-After over its own backoff", () => {
    expect(retryAfterMs(hdr("30"), 0)).toBe(30_000);
  });

  it("backs off exponentially when the server gives no hint", () => {
    expect(retryAfterMs(hdr(null), 0)).toBe(2000);
    expect(retryAfterMs(hdr(null), 2)).toBe(8000);
  });

  it("caps the wait so a shot fails over instead of hanging for minutes", () => {
    expect(retryAfterMs(hdr("9999"), 0)).toBe(60_000);
    expect(retryAfterMs(hdr(null), 20)).toBe(60_000);
  });
});

describe("GoogleVeoProvider request shape", () => {
  it("does NOT send referenceImages to Lite, but keeps the first frame", async () => {
    const { sent } = stubVeo({});
    const p = new GoogleVeoProvider({ apiKey: "k", model: "veo-3.1-lite-generate-preview" });
    await settle(p.generate({ prompt: "x", image: { png: Buffer.from("f") }, referenceImages: [Buffer.from("sheet")] }));
    expect(sent).toHaveLength(1); // no rejection, so no retry
    expect(sent[0]!.instance.image).toBeDefined();
    expect(sent[0]!.instance.referenceImages).toBeUndefined();
  });

  it("sends both to Fast, which supports asset references", async () => {
    const { sent } = stubVeo({});
    const p = new GoogleVeoProvider({ apiKey: "k", model: "veo-3.1-fast-generate-preview" });
    await settle(p.generate({ prompt: "x", image: { png: Buffer.from("f") }, referenceImages: [Buffer.from("sheet")] }));
    expect(sent[0]!.instance.image).toBeDefined();
    expect((sent[0]!.instance.referenceImages as unknown[]).length).toBe(1);
  });

  it("sends the configured clip length as a number", async () => {
    const { sent } = stubVeo({});
    await settle(new GoogleVeoProvider({ apiKey: "k", durationSeconds: 6 }).generate({ prompt: "x" }));
    expect(sent[0]!.parameters.durationSeconds).toBe(6);
    expect(typeof sent[0]!.parameters.durationSeconds).toBe("number");
  });

  it("still strips an unsupported parameter and retries", async () => {
    const { sent } = stubVeo({
      rejectStart: (s) => ("negativePrompt" in s.parameters ? "`negativePrompt` isn't supported by this model." : null),
    });
    await settle(new GoogleVeoProvider({ apiKey: "k" }).generate({ prompt: "x" }));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.parameters.negativePrompt).toBeUndefined();
  });
});

describe("GoogleVeoProvider rate limits", () => {
  it("waits out a 429 on the start call rather than losing the shot", async () => {
    let first = true;
    const { sent } = stubVeo({
      startStatus: () => {
        if (!first) return null;
        first = false;
        return { status: 429, retryAfter: "1" };
      },
    });
    const out = await settle(new GoogleVeoProvider({ apiKey: "k" }).generate({ prompt: "x" }));
    expect(sent).toHaveLength(2);
    expect(out.video.toString()).toBe("MP4");
  });

  it("keeps polling through a 429 — the clip is already being billed", async () => {
    let limited = 2;
    const { pollCount } = stubVeo({ pollStatus: () => (limited-- > 0 ? { status: 429, retryAfter: "1" } : null) });
    const out = await settle(new GoogleVeoProvider({ apiKey: "k" }).generate({ prompt: "x" }));
    expect(pollCount()).toBe(3); // two refused, one succeeded — not abandoned
    expect(out.video.toString()).toBe("MP4");
  });

  it("gives up eventually instead of looping forever", async () => {
    stubVeo({ startStatus: () => ({ status: 429, retryAfter: "1" }) });
    await expect(settle(new GoogleVeoProvider({ apiKey: "k" }).generate({ prompt: "x" }))).rejects.toThrow(/429/);
  });

  it("fails fast on a non-retryable error", async () => {
    stubVeo({ rejectStart: () => "Billing has not been enabled for this project." });
    await expect(settle(new GoogleVeoProvider({ apiKey: "k" }).generate({ prompt: "x" }))).rejects.toThrow(/Billing/);
  });
});
