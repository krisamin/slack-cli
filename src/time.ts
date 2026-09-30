/**
 * Turn a user-supplied time into a Slack ts string ("seconds.micros").
 *
 * Accepted forms, all in the machine's local time zone:
 *   now                  the current moment
 *   30m | 12h | 3d | 2w  that long ago
 *   2026-09-25           midnight at the start of that day
 *   2026-09-25 13:00     that minute (a T separator works too)
 *   anything Date.parse understands, e.g. an ISO string with an offset
 *
 * A bare date means the whole day when it is the upper bound, so
 * `--since 2026-09-25 --until 2026-09-25` covers exactly that one day.
 */
export type Bound = "start" | "end";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RELATIVE = /^(\d+)([mhdw])$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export const parseTime = (raw: string, bound: Bound, now = Date.now()): number => {
  const value = raw.trim();
  if (value === "now") return now;

  const rel = value.match(RELATIVE);
  if (rel?.[1] && rel[2]) return now - Number(rel[1]) * (UNIT_MS[rel[2]] ?? 0);

  const day = value.match(DATE_ONLY);
  if (day?.[1] && day[2] && day[3]) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    // end of day: one microsecond before the next midnight, so the bound stays inclusive
    return bound === "start"
      ? start
      : new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1).getTime() - 0.001;
  }

  // "2026-09-25 13:00" is not ISO; with a T it is, and without an offset JS reads it as local time
  const parsed = Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"));
  if (Number.isNaN(parsed)) {
    throw new Error(`Can't read "${raw}" as a time. Use YYYY-MM-DD, "YYYY-MM-DD HH:mm", 3d / 12h, or now.`);
  }
  return parsed;
};

/** Milliseconds to a Slack ts. toFixed keeps the micro part even when it is zero. */
export const toSlackTs = (ms: number): string => {
  return (ms / 1000).toFixed(6);
};
