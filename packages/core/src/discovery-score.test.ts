import { isVideoPost } from "@clipfactory/discovery";
import { describe, expect, it } from "vitest";
import { scoreVelocity } from "./discovery-score.js";

const NOW = new Date("2026-07-19T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("scoreVelocity", () => {
  it("ranks a young fast climber above an older post with a higher absolute score", () => {
    const young = scoreVelocity({ scoreNow: 4000, sourceCreatedAt: hoursAgo(0.5), now: NOW });
    const old = scoreVelocity({ scoreNow: 9000, sourceCreatedAt: hoursAgo(10), now: NOW });
    expect(young.velocity).toBeGreaterThan(old.velocity);
  });

  it("uses delta rate when a prior sample shows acceleration", () => {
    // Same age/score, but one jumped 3000 since we first saw it 30 min ago.
    const flat = scoreVelocity({
      scoreNow: 5000,
      sourceCreatedAt: hoursAgo(3),
      firstSeenScore: 4900,
      firstSeenAt: hoursAgo(0.5),
      now: NOW,
    });
    const accelerating = scoreVelocity({
      scoreNow: 5000,
      sourceCreatedAt: hoursAgo(3),
      firstSeenScore: 2000,
      firstSeenAt: hoursAgo(0.5),
      now: NOW,
    });
    expect(accelerating.velocity).toBeGreaterThan(flat.velocity);
    expect(accelerating.breakdown.deltaRate).toBeGreaterThan(0);
  });

  it("works on first sight with no prior sample (age-based only)", () => {
    const r = scoreVelocity({ scoreNow: 1200, sourceCreatedAt: hoursAgo(1), now: NOW });
    expect(r.breakdown.deltaRate).toBeNull();
    expect(r.breakdown.ageRate).toBeCloseTo(1200, 0);
    expect(r.velocity).toBeGreaterThan(0);
  });

  it("decays a stale post below a fresh one at the same rate", () => {
    const fresh = scoreVelocity({ scoreNow: 2000, sourceCreatedAt: hoursAgo(2), now: NOW, maxAgeHours: 24 });
    const stale = scoreVelocity({ scoreNow: 48000, sourceCreatedAt: hoursAgo(48), now: NOW, maxAgeHours: 24 });
    // Same ~1000/h age rate, but the 48h post is past maxAge and heavily decayed.
    expect(stale.breakdown.recencyFactor).toBeLessThan(fresh.breakdown.recencyFactor);
    expect(stale.velocity).toBeLessThan(fresh.velocity);
  });
});

describe("reddit isVideoPost", () => {
  const base = { is_video: false, is_self: false, post_hint: undefined, domain: "" };
  it("keeps native reddit video", () => {
    expect(isVideoPost({ ...base, is_video: true, domain: "v.redd.it" })).toBe(true);
  });
  it("keeps known video-host links", () => {
    expect(isVideoPost({ ...base, domain: "youtube.com" })).toBe(true);
    expect(isVideoPost({ ...base, domain: "streamable.com" })).toBe(true);
    expect(isVideoPost({ ...base, post_hint: "hosted:video" })).toBe(true);
  });
  it("drops self/text and image posts", () => {
    expect(isVideoPost({ ...base, is_self: true })).toBe(false);
    expect(isVideoPost({ ...base, domain: "i.redd.it" })).toBe(false);
    expect(isVideoPost({ ...base, domain: "imgur.com" })).toBe(false);
  });
});
