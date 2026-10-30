// Which reminders to schedule on the phone, worked out from the app state. Pure, so it
// is unit-tested; lib/notifications.ts hands the result to expo-notifications.
//
// Same rules as the server dispatcher: a nudge `lead_min` before each session, one at
// the start, a follow-up 30 minutes after if it never started, deadline warnings 7/3/1
// days ahead at 09:00 and a morning briefing on days with sessions. Quiet hours hold
// back everything except the start reminder, and at most 6 others go out per day.

import type { AppState, Block } from './types';
import { addDays, localDate, localMinutes, localTime, localToUtc, timeToMinutes } from './time';

export type ReminderKind = 'lead' | 'start' | 'missed' | 'deadline' | 'briefing';

export interface Reminder {
  id: string;
  kind: ReminderKind;
  at: Date;
  title: string;
  body: string;
  blockId?: string;
  goalId?: string;
  url: string;
}

const DAILY_CAP = 6;
const MAX_TOTAL = 60; // iOS keeps 64 pending notifications per app

export function inQuietHours(at: Date, tz: string, quietStart: string, quietEnd: string): boolean {
  const qs = timeToMinutes(quietStart);
  const qe = timeToMinutes(quietEnd);
  if (qs === qe) return false;
  const m = localMinutes(at, tz);
  return qs < qe ? m >= qs && m < qe : m >= qs || m < qe;
}

function text(kind: ReminderKind, lang: string, v: { name: string; range?: string; lead?: number; goal?: string; days?: number; count?: number; progress?: string }) {
  const ur = lang === 'ur-Latn';
  switch (kind) {
    case 'lead':
      return ur
        ? { title: `${v.name} ${v.lead} minute mein`, body: `${v.range} · Tayyar ho jaiye.` }
        : { title: `${v.name} in ${v.lead} min`, body: `${v.range} · Time to get ready.` };
    case 'start':
      return ur
        ? { title: `${v.name} ka waqt`, body: `${v.range}. Abhi shuru karein ya 10 minute baad.` }
        : { title: `Time for ${v.name}`, body: `${v.range}. Start now or snooze 10 minutes.` };
    case 'missed':
      return ur
        ? { title: `${v.name} reh gaya`, body: 'Koi khaali waqt chun kar ise move kar dein.' }
        : { title: `${v.name} was missed`, body: 'Pick a free slot to move it.' };
    case 'deadline':
      return ur
        ? { title: `${v.goal}: ${v.days} din baqi`, body: v.progress ?? '' }
        : { title: `${v.goal} is due in ${v.days} day${v.days === 1 ? '' : 's'}`, body: v.progress ?? '' };
    case 'briefing':
      return ur
        ? { title: 'Subah bakhair', body: `Aaj ${v.count} session${v.count === 1 ? '' : 's'} hain.` }
        : { title: 'Good morning', body: `${v.count} session${v.count === 1 ? '' : 's'} today.` };
  }
}

export function planReminders(state: AppState, now: Date, horizonDays = 7): Reminder[] {
  const p = state.profile;
  if (!p.notifications_enabled) return [];
  const tz = p.timezone;
  const horizon = new Date(now.getTime() + horizonDays * 86_400_000);
  const quiet = (at: Date) => inQuietHours(at, tz, p.quiet_start, p.quiet_end);
  const lead = (b: Block) => state.goals.find((g) => g.id === b.goal_id)?.rule?.lead_min ?? 10;
  const name = (title: string) => (p.hide_titles ? 'Focus session' : title);
  const out: Reminder[] = [];

  const open = state.blocks.filter(
    (b) => b.kind === 'session' && (b.status === 'planned' || b.status === 'snoozed') && new Date(b.starts_at) < horizon,
  );
  for (const b of open) {
    const start = new Date(b.starts_at);
    const range = `${localTime(b.starts_at, tz)}–${localTime(b.ends_at, tz)}`;
    const vars = { name: name(b.title), range, lead: lead(b) };
    const leadAt = new Date(start.getTime() - vars.lead * 60_000);
    if (vars.lead > 0 && leadAt > now && !quiet(leadAt)) {
      out.push({ id: `lead:${b.id}:${start.getTime()}`, kind: 'lead', at: leadAt, ...text('lead', p.language, vars), blockId: b.id, url: `deepwork://focus/${b.id}` });
    }
    if (start > now) {
      out.push({ id: `start:${b.id}:${start.getTime()}`, kind: 'start', at: start, ...text('start', p.language, vars), blockId: b.id, url: `deepwork://focus/${b.id}` });
    }
    const missedAt = new Date(start.getTime() + 30 * 60_000);
    if (missedAt > now && !quiet(missedAt)) {
      out.push({ id: `missed:${b.id}:${start.getTime()}`, kind: 'missed', at: missedAt, ...text('missed', p.language, vars), blockId: b.id, url: `deepwork://move/${b.id}` });
    }
  }

  const today = localDate(now, tz);
  for (const g of state.goals.filter((x) => x.status === 'active')) {
    for (const days of [7, 3, 1]) {
      const date = addDays(g.deadline, -days);
      if (date < today) continue;
      const at = localToUtc(`${date}T09:00`, tz);
      if (at <= now || at > horizon || quiet(at)) continue;
      const done = g.milestones.filter((m) => m.done_at).length;
      out.push({
        id: `deadline:${g.id}:${days}`,
        kind: 'deadline',
        at,
        ...text('deadline', p.language, {
          name: '',
          goal: p.hide_titles ? 'Your goal' : g.title,
          days,
          progress: `${done} of ${g.milestones.length} milestones done.`,
        }),
        goalId: g.id,
        url: `deepwork://goal/${g.id}`,
      });
    }
  }

  if (p.briefing_at) {
    for (let i = 0; i <= horizonDays; i++) {
      const date = addDays(today, i);
      const sessions = open.filter((b) => localDate(b.starts_at, tz) === date);
      if (sessions.length === 0) continue;
      const at = localToUtc(`${date}T${p.briefing_at.slice(0, 5)}`, tz);
      const first = new Date(sessions[0].starts_at);
      if (at <= now || at >= first || at > horizon || quiet(at)) continue;
      out.push({ id: `briefing:${date}`, kind: 'briefing', at, ...text('briefing', p.language, { name: '', count: sessions.length }), url: 'deepwork://today' });
    }
  }

  // At most 6 non-start reminders per local day, earliest first.
  out.sort((a, b) => a.at.getTime() - b.at.getTime());
  const perDay = new Map<string, number>();
  const kept = out.filter((r) => {
    if (r.kind === 'start') return true;
    const day = localDate(r.at, tz);
    const n = perDay.get(day) ?? 0;
    if (n >= DAILY_CAP) return false;
    perDay.set(day, n + 1);
    return true;
  });
  return kept.slice(0, MAX_TOTAL);
}

/** A stable fingerprint, so unchanged plans aren't rescheduled. */
export function remindersSignature(reminders: Reminder[]): string {
  return reminders.map((r) => `${r.id}@${r.at.getTime()}:${r.title}`).join('|');
}
