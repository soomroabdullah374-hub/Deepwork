// Reminder calls: a goal's rhythm can ring the phone like a call `call_lead_min` before
// each session. A call is for a reminder that went unanswered, so it is called off once
// you answer that session's reminder (tap it or use its buttons), start, move or skip the
// session. The ringing itself is native (modules/deepwork-call); this decides what rings.

import { type CallSpec, cancelCall, scheduleCalls } from '../../modules/deepwork-call';
import { getItem, setItem } from './storage';
import { localDate, localTime } from './time';
import type { AppState } from './types';

export { callsAvailable, canRingFullScreen, openFullScreenSettings, ringIn, stopRinging } from '../../modules/deepwork-call';

const ANSWERED_KEY = 'deepwork.calls.answered';
const DAY = 86_400_000;
const AHEAD = 7 * DAY;

/** The calls to have waiting now; `answered` holds sessions whose reminder was answered. */
export function callsFor(state: AppState, now: Date, answered: ReadonlySet<string>): CallSpec[] {
  if (!state.profile.notifications_enabled) return [];
  const tz = state.profile.timezone;
  const urdu = state.profile.language === 'ur-Latn';
  const calls: CallSpec[] = [];
  for (const b of state.blocks) {
    if (b.kind !== 'session' || (b.status !== 'planned' && b.status !== 'snoozed') || answered.has(b.id)) continue;
    const goal = state.goals.find((g) => g.id === b.goal_id);
    const lead = goal?.status === 'active' ? goal.rule?.call_lead_min ?? 0 : 0;
    if (lead <= 0) continue;
    const at = new Date(b.starts_at).getTime() - lead * 60_000;
    if (at <= now.getTime() + 5_000 || at > now.getTime() + AHEAD) continue;
    const title = state.profile.hide_titles ? (urdu ? 'Aap ka focus session' : 'Your focus session') : b.title;
    const time = localTime(b.starts_at, tz);
    const today = localDate(now, tz) === localDate(b.starts_at, tz);
    calls.push({
      id: b.id,
      at,
      title: 'DeepWork',
      body: urdu ? `${title} · ${time} baje, ${lead} minute mein` : `${title} · ${today ? '' : 'starts '}${time}, in ${lead} min`,
    });
  }
  return calls.sort((a, b) => a.at - b.at);
}

async function answered(): Promise<Map<string, number>> {
  try {
    const raw = await getItem(ANSWERED_KEY);
    const entries = raw ? (JSON.parse(raw) as [string, number][]) : [];
    // a few days is plenty: the sessions are over by then
    return new Map(entries.filter(([, at]) => at > Date.now() - 3 * DAY));
  } catch {
    return new Map();
  }
}

/** Keep the phone's waiting calls in step with the schedule. */
export async function syncCalls(state: AppState): Promise<void> {
  const done = await answered();
  scheduleCalls(callsFor(state, new Date(), new Set(done.keys())));
}

/** Their reminder for this session was answered, or the call itself was: no (more) call. */
export async function answerCall(blockId: string): Promise<void> {
  cancelCall(blockId);
  const done = await answered();
  done.set(blockId, Date.now());
  await setItem(ANSWERED_KEY, JSON.stringify([...done]));
}
