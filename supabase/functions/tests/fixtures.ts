// A small, fixed world shared by the tests: Asia/Karachi (UTC+5), now = Sunday
// 25 Oct 2026 17:15 local. Mirrors the eval context, with real uuids.

import type { AppState, Block, Goal } from '../_shared/state.ts';
import { occupies } from '../_shared/state.ts';
import { localToUtc } from '../_shared/time.ts';

export const TZ = 'Asia/Karachi';
export const NOW = new Date('2026-10-25T12:15:00Z');

export const G_AI = '00000000-0000-4000-8000-0000000000a1';
export const G_CLOUD = '00000000-0000-4000-8000-0000000000a2';
export const G_CASE = '00000000-0000-4000-8000-0000000000a3';
export const C_CLASS = '00000000-0000-4000-8000-0000000000c1';
export const S_SUN25 = '00000000-0000-4000-8000-0000000000b1';
export const S_MON26 = '00000000-0000-4000-8000-0000000000b2';
export const S_WED28 = '00000000-0000-4000-8000-0000000000b3';

const at = (local: string) => localToUtc(local, TZ).toISOString();

function block(id: string, kind: Block['kind'], title: string, start: string, end: string, extra: Partial<Block> = {}): Block {
  return {
    id,
    kind,
    goal_id: null,
    commitment_id: null,
    title,
    starts_at: at(start),
    ends_at: at(end),
    slot_start: at(start),
    status: 'planned',
    minutes_done: null,
    note: null,
    started_at: null,
    finished_at: null,
    created_by: 'generator',
    ...extra,
  };
}

const goal = (id: string, title: string, weekdays: number[], start: string, minutes: number, deadline: string): Goal => ({
  id,
  title,
  why: null,
  deadline,
  status: 'active',
  created_at: '2026-10-01T00:00:00Z',
  rule: { goal_id: id, weekdays, start_time: `${start}:00`, duration_min: minutes, lead_min: 10 },
  milestones: [],
  sessions_done: 0,
  minutes_done: 0,
});

export function makeState(): AppState {
  const classDays = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
  const blocks: Block[] = [
    block(S_SUN25, 'session', 'Cloud Data Engineering labs', '2026-10-25T18:00', '2026-10-25T19:00', { goal_id: G_CLOUD }),
    block(S_MON26, 'session', 'Finish AI Agent portfolio project', '2026-10-26T20:00', '2026-10-26T21:30', { goal_id: G_AI }),
    block(S_WED28, 'session', 'Finish AI Agent portfolio project', '2026-10-28T20:00', '2026-10-28T21:30', { goal_id: G_AI }),
    block('00000000-0000-4000-8000-0000000000b4', 'session', 'Finish AI Agent portfolio project', '2026-10-31T20:00', '2026-10-31T21:30', { goal_id: G_AI }),
    block('00000000-0000-4000-8000-0000000000b5', 'session', 'Write the freelance case study', '2026-10-27T09:00', '2026-10-27T10:00', { goal_id: G_CASE }),
    ...classDays.map((d, i) =>
      block(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, 'commitment', 'Training class', `${d}T14:00`, `${d}T17:00`, {
        commitment_id: C_CLASS,
      })
    ),
  ];
  return {
    now: NOW.toISOString(),
    profile: {
      user_id: 'user-1',
      display_name: 'Abdullah',
      timezone: TZ,
      language: 'en',
      quiet_start: '23:00:00',
      quiet_end: '07:00:00',
      briefing_at: '07:30:00',
      theme: 'auto',
      notifications_enabled: true,
      hide_titles: false,
      speak_replies: true,
      assistant_auto_apply: false,
      onboarded_at: '2026-10-01T00:00:00Z',
    },
    goals: [
      goal(G_AI, 'Finish AI Agent portfolio project', [1, 3, 6], '20:00', 90, '2026-12-15'),
      goal(G_CLOUD, 'Cloud Data Engineering labs', [0], '18:00', 60, '2026-12-31'),
      goal(G_CASE, 'Write the freelance case study', [2], '09:00', 60, '2026-11-30'),
    ],
    commitments: [{
      id: C_CLASS,
      title: 'Training class',
      weekdays: [1, 2, 3, 4],
      start_time: '14:00:00',
      duration_min: 180,
      one_off_date: null,
      starts_on: '2026-10-01',
      created_by: 'app',
      created_at: '2026-10-01T00:00:00Z',
    }],
    blocks,
    conflicts: [],
    streak: { count: 0, since: null },
  };
}

/** check_slots() as Postgres would answer it for this state. */
export function fakeDb(state: AppState) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    // deno-lint-ignore require-await
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ fn, args });
      if (fn !== 'check_slots') throw new Error(`unexpected rpc ${fn}`);
      const ignore = new Set((args.p_ignore_ids as string[]) ?? []);
      const slots = args.p_slots as { starts_at: string; ends_at: string }[];
      return slots.map((s, index) => {
        const hit = state.blocks
          .filter((b) => occupies(b) && !ignore.has(b.id))
          .filter((b) => new Date(b.starts_at) < new Date(s.ends_at) && new Date(s.starts_at) < new Date(b.ends_at))
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
        return {
          index,
          clash: hit ? { id: hit.id, title: hit.title, kind: hit.kind, starts_at: hit.starts_at, ends_at: hit.ends_at } : null,
        };
      }) as T;
    },
  };
}
