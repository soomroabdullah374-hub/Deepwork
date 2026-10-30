// Time-zone helpers built on Intl, so they need no library. Everything is stored in UTC;
// local wall-clock times come from the user's IANA zone, DST included where it applies.

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface WallClock {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock in `tz` at an instant. */
export function wallClock(date: Date | string, tz: string): WallClock {
  const d = typeof date === 'string' ? new Date(date) : date;
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

function offsetMs(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** "2026-10-26T19:00" (or "2026-10-26", "…T19:00:30") in `tz` → the UTC instant. */
export function localToUtc(local: string, tz: string): Date {
  const [datePart, timePart = '00:00'] = local.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mi, ss = 0] = timePart.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mi, ss);
  // Two passes settle the offset, also right next to a DST change.
  const first = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(first), tz);
  return new Date(second);
}

/** Local calendar date "YYYY-MM-DD" of an instant. */
export function localDate(date: Date | string, tz: string): string {
  const w = wallClock(date, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** Local "HH:mm" of an instant. */
export function localTime(date: Date | string, tz: string): string {
  const w = wallClock(date, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** "YYYY-MM-DDTHH:mm" local wall time of an instant. */
export function localStamp(date: Date | string, tz: string): string {
  return `${localDate(date, tz)}T${localTime(date, tz)}`;
}

/** Pure calendar arithmetic on "YYYY-MM-DD" (no zone involved). */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`, both "YYYY-MM-DD". */
export function daysBetween(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday for a calendar date. */
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

/** "Mon 26 Oct" for a calendar date. */
export function dayLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAYS_SHORT[weekdayOf(dateStr)]} ${d} ${MONTHS_SHORT[m - 1]}`;
}

/** "Sunday 25 October 2026" for a calendar date. */
export function longDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAYS_LONG[weekdayOf(dateStr)]} ${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

export function partOfDay(hhmm: string): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = Number(hhmm.slice(0, 2));
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

/** "HH:mm" from a Postgres time ("20:00:00") or "8:05". */
export function hhmm(time: string): string {
  const [h, m = '00'] = time.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0').slice(0, 2)}`;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
