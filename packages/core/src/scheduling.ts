import { DateTime } from "luxon";

export interface CadenceInput {
  /** IANA timezone, e.g. "America/New_York". */
  timezone: string;
  postsPerDay: number;
  /** Active window [start, end) in local hours (0-23). */
  activeStartHour: number;
  activeEndHour: number;
  /** Already-scheduled UTC times for this account (avoid collisions). */
  taken: Date[];
  /** How many new slots to allocate. */
  count: number;
  /** Allocate slots strictly after this instant (default now). */
  from?: Date;
}

/**
 * Assign `count` future posting slots for one account: `postsPerDay` evenly
 * spread across its active window in its timezone, filling the rest of today then
 * subsequent days, skipping slots already taken. Pure + deterministic given `from`.
 */
export function computeSlots(input: CadenceInput): Date[] {
  const zone = input.timezone || "UTC";
  const fromDt = DateTime.fromJSDate(input.from ?? new Date(), { zone });
  const start = Math.max(0, Math.min(23, input.activeStartHour));
  const end = Math.max(start + 1, Math.min(24, input.activeEndHour));
  const perDay = Math.max(1, Math.floor(input.postsPerDay));
  const stepH = (end - start) / perDay;

  const taken = new Set(input.taken.map((d) => Math.round(d.getTime() / 60000)));
  const slots: Date[] = [];
  let day = fromDt.startOf("day");
  let guard = 0;
  while (slots.length < input.count && guard < 500) {
    guard++;
    for (let i = 0; i < perDay && slots.length < input.count; i++) {
      const hourFloat = start + i * stepH;
      const h = Math.floor(hourFloat);
      const m = Math.round((hourFloat - h) * 60);
      const local = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
      if (local <= fromDt) continue; // in the past
      const utc = local.toUTC().toJSDate();
      const bucket = Math.round(utc.getTime() / 60000);
      if (taken.has(bucket)) continue; // collision
      taken.add(bucket);
      slots.push(utc);
    }
    day = day.plus({ days: 1 });
  }
  return slots;
}
