import { planFreezes, type FreezeInsert } from "@clipfactory/media";
import { describe, expect, it } from "vitest";

/**
 * The commentary freezes reshape the timeline: every hold pushes the rest of the
 * clip later. Getting these offsets wrong desyncs the voice from the freeze it's
 * supposed to fill, which is invisible until you watch the render — hence tests.
 */
describe("planFreezes", () => {
  const CLIP = 30;

  it("treats an insert at 0 as a cold open", () => {
    const intro: FreezeInsert = { atSec: 0, durationSec: 3 };
    const plan = planFreezes(CLIP, [intro]);
    expect(plan.startPad).toBe(3);
    expect(plan.offsets).toEqual([0]); // the hold is the very start of the output
    expect(plan.segments).toEqual([{ s: 0, e: null, stop: 0 }]); // no cuts needed
  });

  it("treats an insert at the end as a closing hold", () => {
    const outro: FreezeInsert = { atSec: CLIP, durationSec: 4 };
    const plan = planFreezes(CLIP, [outro]);
    expect(plan.startPad).toBe(0);
    expect(plan.segments).toEqual([{ s: 0, e: null, stop: 4 }]); // hold the last frame
    expect(plan.offsets).toEqual([CLIP]); // voice starts when the clip ends
  });

  it("splits the clip at a mid insert", () => {
    const react: FreezeInsert = { atSec: 12, durationSec: 2 };
    const plan = planFreezes(CLIP, [react]);
    expect(plan.segments).toEqual([
      { s: 0, e: 12, stop: 2 }, // play to 12s, then hold 2s
      { s: 12, e: null, stop: 0 }, // resume
    ]);
    expect(plan.offsets).toEqual([12]);
  });

  it("pushes later lines back by every freeze before them", () => {
    const intro: FreezeInsert = { atSec: 0, durationSec: 3 };
    const r1: FreezeInsert = { atSec: 10, durationSec: 2 };
    const r2: FreezeInsert = { atSec: 20, durationSec: 5 };
    const outro: FreezeInsert = { atSec: CLIP, durationSec: 4 };
    const plan = planFreezes(CLIP, [intro, r1, r2, outro]);

    expect(plan.offsets[0]).toBe(0); // intro
    expect(plan.offsets[1]).toBe(3 + 10); // after the 3s cold open
    expect(plan.offsets[2]).toBe(3 + 20 + 2); // + the 2s react before it
    expect(plan.offsets[3]).toBe(3 + 30 + 2 + 5); // + both reacts
  });

  it("keeps offsets aligned to the caller's order, not sorted order", () => {
    const outro: FreezeInsert = { atSec: CLIP, durationSec: 4 };
    const intro: FreezeInsert = { atSec: 0, durationSec: 3 };
    // Deliberately out of order — the caller gets offsets back positionally.
    const plan = planFreezes(CLIP, [outro, intro]);
    expect(plan.offsets[0]).toBe(3 + CLIP); // outro
    expect(plan.offsets[1]).toBe(0); // intro
  });
});
