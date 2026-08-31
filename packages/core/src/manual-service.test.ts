import { describe, expect, it } from "vitest";
import { ManualService, type ManualSpec } from "./services/manual-service.js";

/**
 * In-memory doubles for the manual clip workflow: plan (no Veo spend) → upload each
 * clip → assemble (enqueue). We assert the SourceVideo is created PENDING and NOT
 * enqueued at plan time, and that assembly refuses until every clip is uploaded.
 */
function harness() {
  const videos = new Map<string, { id: string; storySpec: ManualSpec; status: string; kind: string }>();
  const campaigns: Array<{ id: string; name: string }> = [];
  const enqueued: Array<{ kind: string; payload: unknown }> = [];
  let seq = 0;

  const repos = {
    campaigns: {
      list: async () => campaigns,
      create: async (c: { name: string }) => {
        const row = { id: `camp-${++seq}`, name: c.name };
        campaigns.push(row);
        return row;
      },
    },
    sourceVideos: {
      create: async (v: { storySpec: ManualSpec; status: string; kind: string; title: string }) => {
        const row = { id: `sv-${++seq}`, storySpec: v.storySpec, status: v.status, kind: v.kind };
        videos.set(row.id, row);
        return row;
      },
      byId: async (id: string) => videos.get(id) ?? null,
      update: async (id: string, patch: { storySpec: ManualSpec }) => {
        const row = videos.get(id)!;
        row.storySpec = patch.storySpec;
        return row;
      },
    },
  } as never;

  const llm = {
    writeStory: async () => ({
      title: "A Quiet Resolve",
      description: "desc",
      hashtags: ["#focus"],
      setting: "a rain-lit study at dusk",
      beats: [
        { text: "He sits.", imagePrompt: "a man at a desk" },
        { text: "He rises.", imagePrompt: "the man standing" },
      ],
    }),
    planAnimationShots: async () => ({
      cast: "a lean man in a grey coat",
      shots: [
        { text: "He sits.", imagePrompt: "at the desk", motionPrompt: "slow push-in" },
        { text: "He rises.", imagePrompt: "standing by the window", motionPrompt: "he turns" },
      ],
    }),
    planCookShots: async () => ({
      title: "River Trout",
      description: "desc",
      hashtags: ["#cook"],
      shots: [
        { prompt: "gutting the trout on a stone" },
        { prompt: "trout over open flame" },
      ],
    }),
    planPovShort: async (input: { maxShots: number; direction?: string }) => ({
      title: "POV: a rainy cabin morning",
      description: "desc",
      hashtags: ["#pov", "#cozy"],
      logline: `A calm loop of a rainy cabin morning.${input.direction ? ` (${input.direction})` : ""}`,
      sceneBible: "a warm wooden cabin, steady rain outside, cool daylight warmed by firelight, your own realistic hands in a cream knit sleeve — identical every clip.",
      shots: Array.from({ length: input.maxShots }, (_, i) => ({
        scene: `cabin moment ${i + 1}`,
        motion: `first-person move ${i + 1}`,
        audio: "rain and fire crackle",
      })),
    }),
  } as never;

  const images = {
    generate: async () => ({ image: Buffer.from("png") }),
  } as never;

  const stored = new Set<string>();
  const storage = {
    putBuffer: async (key: string) => { stored.add(key); },
    putFile: async (key: string) => { stored.add(key); },
    exists: async (key: string) => stored.has(key),
    getUrl: async (key: string) => `https://cdn.test/${key}`,
  } as never;

  const dispatcher = {
    enqueue: async (kind: string, payload: unknown) => { enqueued.push({ kind, payload }); },
  } as never;

  const svc = new ManualService(repos, llm, dispatcher, images, storage, 16, 6);
  return { svc, videos, enqueued, stored };
}

describe("ManualService", () => {
  it("plans a Video: writes clip prompts + narration + character ref, PENDING and not enqueued", async () => {
    const { svc, videos, enqueued } = harness();
    const dto = await svc.plan({ format: "video", topic: "discipline on a hard day", length: "short" });

    expect(dto.format).toBe("video");
    expect(dto.aspect).toBe("9:16");
    expect(dto.clips.length).toBeGreaterThan(0);
    expect(dto.characterRefUrl).toContain("manual-ref/");
    expect(dto.uploaded.every((u) => u === null)).toBe(true);

    const row = videos.get(dto.sourceVideoId)!;
    expect(row.status).toBe("PENDING");
    expect(row.kind).toBe("manual");
    expect(row.storySpec.narrationText).toBeTruthy();
    // Planning must NOT spend on video generation / enqueue anything.
    expect(enqueued).toHaveLength(0);
  });

  it("plans a Cook: clip prompts only, no narration or character ref", async () => {
    const { svc } = harness();
    const dto = await svc.plan({ format: "cook", topic: "trout on a river stone", length: "short" });
    expect(dto.format).toBe("cook");
    expect(dto.characterRefUrl).toBeNull();
    expect(dto.clips.length).toBeGreaterThan(0);
  });

  it("plans an experiential POV short: realistic, 9:16, native audio, no on-screen text", async () => {
    const { svc, videos } = harness();
    const dto = await svc.plan({ format: "pov", topic: "a rainy cabin morning", length: "short" });

    expect(dto.format).toBe("pov");
    expect(dto.aspect).toBe("9:16");
    expect(dto.clips.length).toBeGreaterThan(0);
    // Realistic first-person style, no historical/date scaffolding.
    expect(dto.clips[0]!.prompt).toContain("Photorealistic cinematic FIRST-PERSON POV");
    // NO on-screen text anywhere, and no title card.
    expect(dto.clips.every((c) => c.prompt.includes("No on-screen text"))).toBe(true);
    expect(dto.clips.some((c) => c.prompt.includes("ON-SCREEN TEXT"))).toBe(false);
    // The locked scene (place/light/outfit) is repeated verbatim on EVERY clip.
    expect(dto.clips.every((c) => c.prompt.includes("cream knit sleeve"))).toBe(true);
    // Continuity link on later clips; native ambient audio, no music.
    expect(dto.clips[1]!.prompt).toContain("CONTINUES");
    expect(dto.clips.every((c) => c.prompt.includes("no music, no voices"))).toBe(true);
    // No trademark hand reference for experiential POV.
    expect(dto.characterRefUrl).toBeNull();
    expect((dto.characterRefUrls ?? []).length).toBe(0);
    // No anachronism / period scaffolding.
    expect(dto.clips.some((c) => c.prompt.includes("anachronism"))).toBe(false);
    // The approval summary: a logline + one label per beat.
    expect(dto.logline).toContain("rainy cabin morning");
    expect(dto.beatLabels!.length).toBe(dto.clips.length);

    const row = videos.get(dto.sourceVideoId)!;
    // POV keeps native clip audio — no voiceover synthesized.
    expect(row.storySpec.narrationText).toBeUndefined();
    expect(row.storySpec.format).toBe("pov");
  });

  it("refuses to assemble until every clip is uploaded, then enqueues manual.assemble", async () => {
    const { svc, enqueued } = harness();
    const dto = await svc.plan({ format: "cook", topic: "trout", length: "short" });

    await expect(svc.assemble(dto.sourceVideoId)).rejects.toThrow(/upload every clip/);

    for (let i = 0; i < dto.clips.length; i++) {
      const r = await svc.addClip(dto.sourceVideoId, i, `/tmp/clip-${i}.mp4`);
      expect(r.uploaded[i]).toContain(`manual-clip/${dto.sourceVideoId}/${i}.mp4`);
      expect(r.complete).toBe(i === dto.clips.length - 1);
    }

    const res = await svc.assemble(dto.sourceVideoId);
    expect(res.sourceVideoId).toBe(dto.sourceVideoId);
    expect(enqueued).toEqual([{ kind: "manual.assemble", payload: { sourceVideoId: dto.sourceVideoId } }]);
  });

  it("rejects an out-of-range clip index", async () => {
    const { svc } = harness();
    const dto = await svc.plan({ format: "cook", topic: "trout", length: "short" });
    await expect(svc.addClip(dto.sourceVideoId, 99, "/tmp/x.mp4")).rejects.toThrow(/out of range/);
  });
});
