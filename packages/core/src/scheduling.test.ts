import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { computeSlots } from "./scheduling.js";

const base = {
  timezone: "UTC",
  postsPerDay: 4,
  activeStartHour: 9,
  activeEndHour: 21,
  taken: [] as Date[],
};
// A fixed reference so tests are deterministic (03:00 UTC).
const FROM = new Date("2026-07-13T03:00:00Z");

describe("computeSlots", () => {
  it("returns exactly `count` future slots", () => {
    const slots = computeSlots({ ...base, count: 10, from: FROM });
    expect(slots).toHaveLength(10);
    for (const s of slots) expect(s.getTime()).toBeGreaterThan(FROM.getTime());
    // strictly increasing
    for (let i = 1; i < slots.length; i++) expect(slots[i]!.getTime()).toBeGreaterThan(slots[i - 1]!.getTime());
  });

  it("keeps slots inside the active window in the account timezone", () => {
    const slots = computeSlots({ ...base, timezone: "America/New_York", count: 8, from: FROM });
    for (const s of slots) {
      const h = DateTime.fromJSDate(s, { zone: "America/New_York" }).hour;
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(21);
    }
  });

  it("puts `postsPerDay` slots per day", () => {
    const slots = computeSlots({ ...base, postsPerDay: 4, count: 8, from: FROM });
    const byDay = new Map<string, number>();
    for (const s of slots) {
      const day = DateTime.fromJSDate(s, { zone: "UTC" }).toISODate()!;
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    for (const n of byDay.values()) expect(n).toBeLessThanOrEqual(4);
  });

  it("skips slots that are already taken", () => {
    const first = computeSlots({ ...base, count: 3, from: FROM });
    const withTaken = computeSlots({ ...base, count: 3, from: FROM, taken: [first[0]!] });
    // The previously-first slot should no longer appear.
    expect(withTaken.map((d) => d.getTime())).not.toContain(first[0]!.getTime());
  });
});
