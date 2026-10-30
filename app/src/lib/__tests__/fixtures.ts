// The sample world from the design specs: Karachi, Sunday 25 Oct 2026, 17:15.

import { localToUtc } from '../time';
import type { AppState, Block, Goal } from '../types';

export const TZ = 'Asia/Karachi';
export const NOW = new Date('2026-10-25T12:15:00Z');
const at = (local: string) => localToUtc(local, TZ).toISOString();

export function block(id: string, kind: Block['kind'], title: string, start: string, end: string, extra: Partial<Block> = {}): Block {
  return {
    id, kind, goal_id: null, commitment_id: null, title,
    starts_at: at(start), ends_at: at(end), slot_start: at(start),
    status: 'planned', minutes_done: null, note: null, started_at: null, finished_at: null, created_by: 'generator',
    ...extra,
  };
}

const goal = (id: string, title: string, weekdays: number[], start: string, minutes: number, deadline: string, done: number, total: number): Goal => ({
  id, title, why: null, start_date: null, deadline, status: 'active', created_at: '2026-10-05T00:00:00Z',
  rule: { goal_id: id, weekdays, start_time: `${start}:00`, duration_min: minutes, lead_min: 10 },
  milestones: Array.from({ length: total }, (_, i) => ({ id: `${id}-m${i}`, position: i, title: `Step ${i + 1}`, done_at: i < done ? '2026-10-20T00:00:00Z' : null })),
  sessions_done: 2, minutes_done: 175,
});

export function makeState(over: Partial<AppState> = {}): AppState {
  return {
    now: NOW.toISOString(),
    profile: {
      user_id: 'u1', display_name: 'Abdullah Soomro', timezone: TZ, language: 'en',
      quiet_start: '23:00:00', quiet_end: '07:00:00', briefing_at: '07:30:00', theme: 'auto',
      notifications_enabled: true, hide_titles: false, speak_replies: true, assistant_auto_apply: false,
      onboarded_at: '2026-10-01T00:00:00Z',
    },
    goals: [
      goal('g_ai', 'Finish AI Agent portfolio project', [1, 3, 6], '20:00', 90, '2026-12-15', 2, 5),
      goal('g_cloud', 'Cloud Data Engineering labs', [0], '18:00', 60, '2027-01-31', 2, 8),
    ],
    commitments: [],
    blocks: [
      block('done1', 'session', 'Cloud Data Engineering labs', '2026-10-25T09:00', '2026-10-25T10:00', { goal_id: 'g_cloud', status: 'done', minutes_done: 60 }),
      block('s_sun25', 'session', 'Cloud Data Engineering labs', '2026-10-25T18:00', '2026-10-25T19:00', { goal_id: 'g_cloud' }),
      block('s_sat24', 'session', 'Finish AI Agent portfolio project', '2026-10-24T20:00', '2026-10-24T21:30', { goal_id: 'g_ai', status: 'missed' }),
      block('s_wed21', 'session', 'Finish AI Agent portfolio project', '2026-10-21T20:00', '2026-10-21T21:30', { goal_id: 'g_ai', status: 'done', minutes_done: 90 }),
      block('s_mon19', 'session', 'Finish AI Agent portfolio project', '2026-10-19T20:00', '2026-10-19T21:30', { goal_id: 'g_ai', status: 'done', minutes_done: 85 }),
      block('s_mon26', 'session', 'Finish AI Agent portfolio project', '2026-10-26T20:00', '2026-10-26T21:30', { goal_id: 'g_ai' }),
      block('c_mon26', 'commitment', 'Training class', '2026-10-26T14:00', '2026-10-26T17:00', { commitment_id: 'c1' }),
    ],
    conflicts: [],
    streak: { count: 1, since: '2026-10-25T04:00:00Z' },
    ...over,
  };
}
