/** Local calendar helpers in an IANA time zone, with no dependencies. */

function parts(d: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** YYYY-MM-DD in the time zone. */
export function localDate(d: Date, timeZone = "UTC"): string {
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 0 = Sunday ... 6 = Saturday, in the time zone. */
export function localWeekday(d: Date, timeZone = "UTC"): number {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts(d, timeZone).weekday ?? "Sun");
}

/** ISO week label, e.g. 2026-W43, for a YYYY-MM-DD date. */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The seven YYYY-MM-DD dates of the ISO week that contains `day`, Monday first. */
export function weekDays(day: string): string[] {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * The next time the local clock reads `hour:minute` in the zone. Steps forward a
 * minute at a time from now; cheap enough for a job that runs once a day.
 */
export function nextLocalTime(now: Date, hour: number, minute: number, timeZone = "UTC"): Date {
  const t = new Date(Math.floor(now.getTime() / 60000) * 60000 + 60000);
  for (let i = 0; i < 60 * 24 * 2; i++) {
    const p = parts(t, timeZone);
    if (Number(p.hour) === hour && Number(p.minute) === minute) return t;
    t.setTime(t.getTime() + 60000);
  }
  throw new Error(`no ${hour}:${minute} in ${timeZone} within two days`);
}
