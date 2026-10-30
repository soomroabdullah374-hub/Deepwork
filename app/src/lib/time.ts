// Time-zone helpers (same rules as the server): store UTC, show the user's zone.
// Built on Intl; if the engine can't format a zone it falls back to the device clock.

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
/** Monday-first order of weekday numbers, as the design shows weeks. */
export const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

export interface WallClock {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatter(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    try {
      const f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      f.formatToParts(new Date());
      formatters.set(tz, f);
    } catch {
      formatters.set(tz, null);
    }
  }
  return formatters.get(tz) ?? null;
}

export function wallClock(date: Date | string | number, tz: string): WallClock {
  const d = date instanceof Date ? date : new Date(date);
  const f = formatter(tz);
  if (!f) {
    return {
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
      hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
    };
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return {
    year: parts.year, month: parts.month, day: parts.day,
    hour: parts.hour % 24, minute: parts.minute, second: parts.second,
  };
}

function offsetMs(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** "2026-10-26T19:00" (or a date) in `tz` → the instant. */
export function localToUtc(local: string, tz: string): Date {
  const [datePart, timePart = '00:00'] = local.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mi, ss = 0] = timePart.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mi, ss);
  if (!formatter(tz)) return new Date(y, m - 1, d, hh, mi, ss);
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}

export function localDate(date: Date | string | number, tz: string): string {
  const w = wallClock(date, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

export function localTime(date: Date | string | number, tz: string): string {
  const w = wallClock(date, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** Minutes since local midnight. */
export function localMinutes(date: Date | string | number, tz: string): number {
  const w = wallClock(date, tz);
  return w.hour * 60 + w.minute;
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the week containing `dateStr`. */
export function mondayOf(dateStr: string): string {
  return addDays(dateStr, -((weekdayOf(dateStr) + 6) % 7));
}

export function hhmm(time: string): string {
  const [h, m = '00'] = time.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0').slice(0, 2)}`;
}

export function timeToMinutes(time: string): number {
  const [h, m] = hhmm(time).split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

/** "Mon 26 Oct" */
export function dayLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAYS_SHORT[weekdayOf(dateStr)]} ${d} ${MONTHS_SHORT[m - 1]}`;
}

/** "26 Oct" */
export function shortDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

/** "Sunday, 25 October" */
export function longDay(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAYS_LONG[weekdayOf(dateStr)]}, ${d} ${MONTHS_LONG[m - 1]}`;
}

/** "Tuesday 15 December" */
export function longDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAYS_LONG[weekdayOf(dateStr)]} ${d} ${MONTHS_LONG[m - 1]}`;
}

export function partOfDay(minutes: number): 'morning' | 'afternoon' | 'evening' {
  if (minutes >= 4 * 60 && minutes < 12 * 60) return 'morning';
  if (minutes >= 12 * 60 && minutes < 17 * 60) return 'afternoon';
  return 'evening';
}

/** "in 45 min", "in 2 h 5 min", "now" */
export function relativeIn(from: Date, to: Date): string {
  const mins = Math.round((to.getTime() - from.getTime()) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) {
    const days = Math.round(h / 24);
    return `in ${days} day${days === 1 ? '' : 's'}`;
  }
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Karachi';
  } catch {
    return 'Asia/Karachi';
  }
}

/** "PKT, UTC+5" style label for a zone at a given moment. */
export function zoneLabel(tz: string, at = new Date()): string {
  const offset = Math.round(offsetMs(at, tz) / 60_000);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const utc = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`;
  let short = '';
  try {
    short = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    short = '';
  }
  return short && !short.startsWith('GMT') ? `${short}, ${utc}` : utc;
}
