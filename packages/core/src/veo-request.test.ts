import { GoogleVeoProvider } from "@clipfactory/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * These assert the SERIALIZED request body, not the TypeScript types. Both bugs
 * these cover were invisible to the compiler and only surfaced as a 400 from
 * Google after a job had already started.
 */
const realFetch = globalThis.fetch;

let captured: { url: string; body: any } | null = null;

beforeEach(() => {
  captured = null;
  globalThis.fetch = (async (url: string, init: any) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return { ok: false, status: 599, text: async () => "intercepted" } as any;
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const generate = async (opts: Record<string, unknown>, input: Record<string, unknown>) => {
  const p = new GoogleVeoProvider({ apiKey: "test", ...opts } as never);
  await p.generate(input as never).catch(() => {});
  return captured!.body;
};

describe("Veo request body", () => {
  it("sends durationSeconds as a NUMBER", async () => {
    // Google's parameter table documents a string, but the API rejects "8" with
    // "The value type for durationSeconds needs to be a number" (400).
    const body = await generate({ durationSeconds: 8 }, { prompt: "x" });
    expect(typeof body.parameters.durationSeconds).toBe("number");
    expect(body.parameters.durationSeconds).toBe(8);
  });

  it("coerces a string duration, since env vars always arrive as strings", async () => {
    const body = await generate({ durationSeconds: "8" }, { prompt: "x" });
    expect(typeof body.parameters.durationSeconds).toBe("number");
    expect(body.parameters.durationSeconds).toBe(8);
  });

  it("uses allow_all for text-to-video", async () => {
    const body = await generate({}, { prompt: "x" });
    expect(body.parameters.personGeneration).toBe("allow_all");
    expect(body.instances[0].image).toBeUndefined();
  });

  it("switches to allow_adult when a seed image is present", async () => {
    // Not interchangeable: Google permits allow_all ONLY for text-to-video and
    // requires allow_adult for image-to-video. The wrong one 400s every request.
    const body = await generate({}, { prompt: "x", image: { png: Buffer.from("fake") } });
    expect(body.parameters.personGeneration).toBe("allow_adult");
  });

  it("passes the seed image as base64 with a mime type", async () => {
    const png = Buffer.from("fake-png-bytes");
    const body = await generate({}, { prompt: "x", image: { png } });
    expect(body.instances[0].image.bytesBase64Encoded).toBe(png.toString("base64"));
    expect(body.instances[0].image.mimeType).toBe("image/png");
  });

  it("lets the caller override the negative prompt (stick figures need faces allowed)", async () => {
    const dflt = await generate({}, { prompt: "x" });
    expect(dflt.parameters.negativePrompt).toContain("human faces");
    const custom = await generate({}, { prompt: "x", negativePrompt: "photorealistic, blurry" });
    expect(custom.parameters.negativePrompt).toBe("photorealistic, blurry");
  });

  it("does NOT send negativePrompt to Lite, which rejects it", async () => {
    // Lite rejects the field; sending it costs a wasted (rejected) request per
    // shot against Lite's ~10 RPM preview quota, which is what turned a soft
    // rate limit into a run that 429'd on every shot. Gate, don't strip-retry.
    const body = await generate({ model: "veo-3.1-lite-generate-preview" }, { prompt: "x" });
    expect(body.parameters.negativePrompt).toBeUndefined();
  });

  it("still sends negativePrompt to Fast, which supports it", async () => {
    const body = await generate({ model: "veo-3.1-fast-generate-preview" }, { prompt: "x" });
    expect(body.parameters.negativePrompt).toContain("human faces");
  });

  it("targets the configured model on the predictLongRunning endpoint", async () => {
    const body = await generate({ model: "veo-3.1-lite-generate-preview" }, { prompt: "x" });
    expect(captured!.url).toContain("veo-3.1-lite-generate-preview:predictLongRunning");
    expect(body.parameters.aspectRatio).toBe("9:16");
  });
});
