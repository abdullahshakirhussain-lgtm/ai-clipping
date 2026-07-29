import { OpenAiImageProvider } from "@clipfactory/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The frame-to-frame chain is what keeps the same stick figures across
 * independently generated animation clips. It was silently dead once already:
 * `referenceImage` was passed through but the OpenAI provider ignored it, so
 * every frame was drawn from scratch and nothing failed loudly.
 */
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; form?: FormData; json?: any; headers: any }>;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init: any) => {
    const entry: any = { url: String(url), headers: init.headers };
    if (init.body instanceof FormData) entry.form = init.body;
    else entry.json = JSON.parse(init.body);
    calls.push(entry);
    return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from("IMG").toString("base64") }] }) } as any;
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const provider = () => new OpenAiImageProvider({ apiKey: "test", model: "gpt-image-1-mini", quality: "low" });

describe("OpenAiImageProvider", () => {
  it("edits the previous frame when one is supplied", async () => {
    await provider().generate({ prompt: "same figures, now walking", referenceImage: Buffer.from("PNGBYTES") });
    expect(calls[0]!.url).toContain("/v1/images/edits");
    expect(calls[0]!.form).toBeInstanceOf(FormData);
  });

  it("uploads the reference bytes unchanged", async () => {
    const png = Buffer.from("PNGBYTES-exact");
    await provider().generate({ prompt: "x", referenceImage: png });
    const blob = calls[0]!.form!.get("image") as Blob;
    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe("PNGBYTES-exact");
  });

  it("lets fetch set the multipart boundary itself", async () => {
    // A hand-set Content-Type omits the boundary and the request is unparseable.
    await provider().generate({ prompt: "x", referenceImage: Buffer.from("p") });
    expect(Object.keys(calls[0]!.headers)).not.toContain("Content-Type");
  });

  it("draws from scratch when there is no reference frame", async () => {
    await provider().generate({ prompt: "a scene" });
    expect(calls[0]!.url).toContain("/v1/images/generations");
    expect(calls[0]!.json.prompt).toBe("a scene");
  });

  it("falls back to a fresh drawing when the edit is rejected", async () => {
    // Worst case must equal the old behaviour — never a failed render.
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/edits")) return { ok: false, status: 400, text: async () => "no" } as any;
      return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from("FRESH").toString("base64") }] }) } as any;
    }) as any;
    const out = await provider().generate({ prompt: "x", referenceImage: Buffer.from("p") });
    expect(out.image.toString()).toBe("FRESH");
  });
});
