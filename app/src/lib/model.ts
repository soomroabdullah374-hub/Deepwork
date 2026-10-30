// Pure functions that turn the app state into what the screens show. No React here,
// so they are unit-tested directly.

import type { AppState, Block, Goal, Rule } from './types';
import {
  addDays,
  daysBetween,
  hhmm,
  localDate,
  localMinutes,
  localTime,
  MONDAY_FIRST,
  minutesBetween,
  partOfDay,
  WEEKDAY_LETTERS,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
  weekdayOf,
} from './time';

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
export const numberWord = (n: number) => (n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n));
const plural = (n: number, word: string) => `${word}${n === 1 ? '' : 's'}`;

export const isOpenSession = (b: Block) =>
  b.kind === 'session' && (b.status === 'planned' || b.status === 'snoozed' || b.status === 'in_progress');
export const holdsTime = (b: Block) => b.status !== 'cancelled' && b.status !== 'skipped';

export function greeting(now: Date, tz: string, name: string): string {
  const first = name.trim().split(/\s+/)[0];
  const part = partOfDay(localMinutes(now, tz));
  return `Good ${part}${first ? `, ${first}` : ''}.`;
}

export function blocksOn(blocks: Block[], date: string, tz: string): Block[] {
  return blocks
    .filter((b) => localDate(b.starts_at, tz) === date)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** Missed sessions from the last week that have not been moved or redone. */
export function missedSessions(state: AppState, now: Date): Block[] {
  const tz = state.profile.timezone;
  const since = addDays(localDate(now, tz), -7);
  return state.blocks
    .filter((b) => b.kind === 'session' && b.status === 'missed' && localDate(b.starts_at, tz) >= since)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
}

/** "One session left today, and one to reschedule." */
export function todaySummary(state: AppState, now: Date): string {
  const tz = state.profile.timezone;
  const today = localDate(now, tz);
  const left = state.blocks.filter(
    (b) => isOpenSession(b) && localDate(b.starts_at, tz) === today && new Date(b.ends_at) > now,
  ).length;
  const missed = missedSessions(state, now).length;
  const first = left === 0 ? 'No sessions left today' : `${numberWord(left)} ${plural(left, 'session')} left today`;
  if (missed === 0) return `${first}.`;
  return `${first}, and ${numberWord(missed).toLowerCase()} to reschedule.`;
}

/** The session the Up next card shows: running now, or the next one still to come. */
export function nextSession(state: AppState, now: Date): Block | null {
  const open = state.blocks
    .filter((b) => isOpenSession(b) && new Date(b.ends_at) > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return open[0] ?? null;
}

export function goalById(state: AppState, id: string | null | undefined): Goal | undefined {
  return id ? state.goals.find((g) => g.id === id) : undefined;
}

/** Share of the plan done (milestones), 0–1. */
export function goalProgress(goal: Goal): number {
  if (goal.milestones.length === 0) return 0;
  return goal.milestones.filter((m) => m.done_at).length / goal.milestones.length;
}

export function currentMilestone(goal: Goal) {
  return goal.milestones.find((m) => !m.done_at) ?? null;
}

export function milestonesDone(goal: Goal): number {
  return goal.milestones.filter((m) => m.done_at).length;
}

export function goalNextSession(state: AppState, goal: Goal, now: Date): Block | null {
  return (
    state.blocks
      .filter((b) => b.goal_id === goal.id && isOpenSession(b) && new Date(b.ends_at) > now)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null
  );
}

/** "M · W · S" in Monday-first order. */
export function cadenceLetters(weekdays: number[]): string {
  return MONDAY_FIRST.filter((d) => weekdays.includes(d)).map((d) => WEEKDAY_LETTERS[d]).join(' · ');
}

/** "Mon · Wed · Sat" */
export function cadenceShort(weekdays: number[]): string {
  return MONDAY_FIRST.filter((d) => weekdays.includes(d)).map((d) => WEEKDAYS_SHORT[d]).join(' · ');
}

/** "Mondays" / "Sundays" / "Mon, Wed" for a set of days. */
export function daysPhrase(weekdays: number[]): string {
  const days = MONDAY_FIRST.filter((d) => weekdays.includes(d));
  if (days.length === 7) return 'Every day';
  if (days.length === 1) return `${WEEKDAYS_LONG[days[0]]}s`;
  return days.map((d) => WEEKDAYS_SHORT[d]).join(', ');
}

export function daysLeft(goal: Goal, now: Date, tz: string): number {
  return Math.max(0, daysBetween(localDate(now, tz), goal.deadline));
}

/** Sessions a rhythm gives from `from` (exclusive) to `to` (inclusive), both local dates. */
export function sessionsBetween(weekdays: number[], from: string, to: string): number {
  let n = 0;
  const days = daysBetween(from, to);
  for (let i = 1; i <= days; i++) if (weekdays.includes(weekdayOf(addDays(from, i)))) n++;
  return n;
}

/** "Deep work · session 3 of 22" numbers for a goal. */
export function sessionNumber(goal: Goal, tz: string): { n: number; of: number } {
  const start = addDays(localDate(goal.created_at, tz), -1);
  const total = goal.rule ? sessionsBetween(goal.rule.weekdays, start, goal.deadline) : 0;
  const n = goal.sessions_done + 1;
  return { n, of: Math.max(total, n) };
}

/** Lead reminder time, e.g. "19:50" for 20:00 with a 10-minute nudge. */
export function nudgeTime(rule: Pick<Rule, 'start_time' | 'lead_min'>): string {
  const [h, m] = hhmm(rule.start_time).split(':').map(Number);
  const t = (h * 60 + m - rule.lead_min + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Pairs of blocks that overlap (should always be zero; the database forbids it). */
export function overlapCount(blocks: Block[]): number {
  const live = blocks.filter(holdsTime).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  let n = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length && live[j].starts_at < live[i].ends_at; j++) n++;
  }
  return n;
}

// ───────────────────────── insights
export interface DayBar {
  date: string;
  letter: string;
  plannedMin: number;
  doneMin: number;
  missedMin: number;
  isToday: boolean;
}

export interface WeekStats {
  start: string; // Monday
  end: string; // Sunday
  shownUp: number;
  due: number;
  rate: number; // 0–1
  doneHours: number;
  plannedHours: number;
  days: DayBar[];
  byGoal: { goalId: string; title: string; doneHours: number; plannedHours: number; today: boolean }[];
}

export function weekStats(state: Pick<AppState, 'goals' | 'profile'>, blocks: Block[], monday: string, now: Date): WeekStats {
  const tz = state.profile.timezone;
  const today = localDate(now, tz);
  const end = addDays(monday, 6);
  const sessions = blocks.filter((b) => {
    const d = localDate(b.starts_at, tz);
    return b.kind === 'session' && b.status !== 'cancelled' && d >= monday && d <= end;
  });
  const length = (b: Block) => minutesBetween(b.starts_at, b.ends_at);
  const days: DayBar[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    const on = sessions.filter((b) => localDate(b.starts_at, tz) === date);
    return {
      date,
      letter: WEEKDAY_LETTERS[weekdayOf(date)],
      plannedMin: on.reduce((s, b) => s + length(b), 0),
      doneMin: on.filter((b) => b.status === 'done').reduce((s, b) => s + (b.minutes_done ?? length(b)), 0),
      missedMin: on.filter((b) => b.status === 'missed').reduce((s, b) => s + length(b), 0),
      isToday: date === today,
    };
  });
  const past = sessions.filter((b) => b.status === 'done' || b.status === 'missed' || b.status === 'skipped');
  const shownUp = past.filter((b) => b.status === 'done').length;
  const byGoal = state.goals
    .map((g) => {
      const mine = sessions.filter((b) => b.goal_id === g.id);
      return {
        goalId: g.id,
        title: g.title,
        doneHours: mine.filter((b) => b.status === 'done').reduce((s, b) => s + (b.minutes_done ?? length(b)), 0) / 60,
        plannedHours: mine.reduce((s, b) => s + length(b), 0) / 60,
        today: mine.some((b) => localDate(b.starts_at, tz) === today && isOpenSession(b)),
      };
    })
    .filter((g) => g.plannedHours > 0);
  return {
    start: monday,
    end,
    shownUp,
    due: past.length,
    rate: past.length ? shownUp / past.length : 0,
    doneHours: days.reduce((s, d) => s + d.doneMin, 0) / 60,
    plannedHours: days.reduce((s, d) => s + d.plannedMin, 0) / 60,
    days,
    byGoal,
  };
}

/** "3 in a row since Monday." */
export function streakLine(streak: { count: number; since: string | null }, tz: string, now: Date): string | null {
  if (!streak.count || !streak.since) return null;
  const since = localDate(streak.since, tz);
  const days = daysBetween(since, localDate(now, tz));
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? WEEKDAYS_LONG[weekdayOf(since)] : `${days} days ago`;
  return `${streak.count} in a row since ${when}.`;
}

export function hoursLabel(h: number): string {
  return h.toFixed(1);
}

/** The local "now" line position and labels for the Your day ribbon (06–24). */
export function dayRibbon(blocks: Block[], now: Date, tz: string, from = 6 * 60, to = 24 * 60) {
  const span = to - from;
  const pos = (minutes: number) => Math.min(1, Math.max(0, (minutes - from) / span));
  const nowMin = localMinutes(now, tz);
  const today = localDate(now, tz);
  return {
    now: pos(nowMin),
    nowLabel: localTime(now, tz),
    items: blocks
      .filter((b) => holdsTime(b) && localDate(b.starts_at, tz) === today)
      .map((b) => {
        const start = localMinutes(b.starts_at, tz);
        const end = localDate(b.ends_at, tz) === today ? localMinutes(b.ends_at, tz) : 24 * 60;
        return { block: b, left: pos(start), right: pos(end) };
      })
      .filter((i) => i.right > i.left),
  };
}

export function weekdayName(date: string): string {
  return WEEKDAYS_LONG[weekdayOf(date)];
}
