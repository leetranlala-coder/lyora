/** Time helpers. All timestamps are stored as UTC ISO strings. */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function iso(d: Date): string {
  return d.toISOString();
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

export function hoursBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

/** Local hour (0-23) of a date in an IANA timezone. */
export function localHour(d: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", hourCycle: "h23" }).format(d);
  return Number(h);
}

/** UTC instant of local midnight (start of "today") for the given timezone. */
export function startOfLocalDay(d: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const offsetMs = asUtc - Math.floor(d.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!) - offsetMs);
}

/**
 * Move a date forward into the allowed sending window [startHour, endHour) in the business timezone.
 * Returns the same date if it is already inside the window.
 */
export function nextTimeInWindow(d: Date, timeZone: string, startHour: number, endHour: number): Date {
  let t = new Date(d);
  for (let i = 0; i < 48; i++) {
    const h = localHour(t, timeZone);
    if (h >= startHour && h < endHour) return t;
    t = new Date(Math.ceil((t.getTime() + 1) / 3_600_000) * 3_600_000); // next whole hour
  }
  return t;
}

export function formatLocal(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(d));
}
