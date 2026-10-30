// The 40-utterance eval from 02_Prompts/ASSISTANT_SYSTEM_PROMPT.md: fixed context, fixed
// "now" (Sunday 25 Oct 2026, 17:15, Asia/Karachi), text input, real model.
// A case passes when the plan's actions match on type, ids, start_local and duration
// (plus weekly repeat days and rhythm fields where the case states them). A clarify
// counts as correct when a clarify is expected. Titles are not compared.

import { planWithLlm } from './planner.ts';
import type { PromptContext } from './prompt.ts';
import type { Plan, PlanAction } from './schema.ts';
import { calendarLine } from './planner.ts';

type Rule = { weekdays: number[]; start_time: string; duration_min: number; lead_min: number };

export const EVAL_GOALS: { id: string; title: string; status: 'active'; deadline: string; rule: Rule }[] = [
  {
    id: 'g_ai',
    title: 'Finish AI Agent portfolio project',
    status: 'active',
    deadline: '2026-12-15',
    rule: { weekdays: [1, 3, 6], start_time: '20:00', duration_min: 90, lead_min: 10 },
  },
  {
    id: 'g_cloud',
    title: 'Cloud Data Engineering labs',
    status: 'active',
    deadline: '2026-12-31',
    rule: { weekdays: [0], start_time: '18:00', duration_min: 60, lead_min: 10 },
  },
  {
    id: 'g_case',
    title: 'Write the freelance case study',
    status: 'active',
    deadline: '2026-11-30',
    rule: { weekdays: [2], start_time: '09:00', duration_min: 60, lead_min: 10 },
  },
];

export const EVAL_CONTEXT: PromptContext = {
  timezone: 'Asia/Karachi',
  nowLocal: 'Sunday 25 October 2026, 17:15',
  weekday: 'Sunday',
  goals: EVAL_GOALS,
  sessions: [
    { id: 's_sun25', goal_id: 'g_cloud', title: 'Cloud Data Engineering labs', day: 'Sun', start: '2026-10-25T18:00', end: '19:00', status: 'planned' },
    { id: 's_mon26', goal_id: 'g_ai', title: 'Finish AI Agent portfolio project', day: 'Mon', start: '2026-10-26T20:00', end: '21:30', status: 'planned' },
    { id: 's_wed28', goal_id: 'g_ai', title: 'Finish AI Agent portfolio project', day: 'Wed', start: '2026-10-28T20:00', end: '21:30', status: 'planned' },
  ],
  commitments: [
    { id: 'c_class', title: 'Training class', weekdays: [1, 2, 3, 4], start_time: '14:00', duration_min: 180 },
  ],
  calendar: calendarLine('2026-10-25'),
};

type Expect =
  | { type: 'clarify' }
  | { type: 'none' }
  | { type: 'add_commitment'; start: string; min: number; repeat?: number[] }
  | { type: 'add_session'; goal: string; start: string; min: number }
  | { type: 'move_session'; session: string; start: string }
  | { type: 'cancel_session'; session: string }
  | { type: 'delete_commitment'; commitment: string; scope: 'one' | 'series'; date?: string }
  | { type: 'update_rule'; goal: string; rule: Partial<Rule> };

export interface EvalCase {
  n: number;
  text: string;
  expect: Expect[];
}

const clarify: Expect = { type: 'clarify' };
const none: Expect = { type: 'none' };

export const EVAL_CASES: EvalCase[] = [
  { n: 1, text: 'Add gym on Sunday at seven for an hour', expect: [clarify] },
  { n: 2, text: 'Every Sunday gym at 7 pm for an hour', expect: [{ type: 'add_commitment', start: '2026-11-01T19:00', min: 60, repeat: [0] }] },
  { n: 3, text: "Move Monday's portfolio session to Thursday at eight", expect: [{ type: 'move_session', session: 's_mon26', start: '2026-10-29T20:00' }] },
  { n: 4, text: 'Put a cloud lab on Friday', expect: [clarify] },
  { n: 5, text: "Cancel tonight's lab", expect: [{ type: 'cancel_session', session: 's_sun25' }] },
  { n: 6, text: 'kal shaam 7 baje gym add kar do', expect: [{ type: 'add_commitment', start: '2026-10-26T19:00', min: 60 }] },
  { n: 7, text: 'peer wala AI session budh ko shift kar do raat 9 baje', expect: [{ type: 'move_session', session: 's_mon26', start: '2026-10-28T21:00' }] },
  { n: 8, text: 'har itwaar subah 10 baje parhai ka ek ghanta rakh do', expect: [{ type: 'add_commitment', start: '2026-11-01T10:00', min: 60, repeat: [0] }] },
  { n: 9, text: 'aaj ka lab cancel kar do', expect: [{ type: 'cancel_session', session: 's_sun25' }] },
  { n: 10, text: 'juma ko sarhe 8 baje case study ka session daal do', expect: [{ type: 'add_session', goal: 'g_case', start: '2026-10-30T20:30', min: 60 }] },
  { n: 11, text: 'Make my AI sessions 2 hours instead of 90 minutes', expect: [{ type: 'update_rule', goal: 'g_ai', rule: { duration_min: 120 } }] },
  { n: 12, text: 'Remind me 15 minutes before instead of 10', expect: [clarify] },
  { n: 13, text: 'Training class is cancelled this Thursday', expect: [{ type: 'delete_commitment', commitment: 'c_class', scope: 'one', date: '2026-10-29' }] },
  { n: 14, text: "I don't have class anymore", expect: [{ type: 'delete_commitment', commitment: 'c_class', scope: 'series' }] },
  { n: 15, text: 'Add a doctor visit tomorrow at 11', expect: [{ type: 'add_commitment', start: '2026-10-26T11:00', min: 60 }] },
  { n: 16, text: 'parson dopahar 2 baje meeting hai', expect: [{ type: 'add_commitment', start: '2026-10-27T14:00', min: 60 }] },
  { n: 17, text: "Shift Wednesday's session one hour earlier", expect: [{ type: 'move_session', session: 's_wed28', start: '2026-10-28T19:00' }] },
  { n: 18, text: 'Skip Saturday', expect: [clarify] },
  { n: 19, text: "What's on tomorrow?", expect: [none] },
  { n: 20, text: 'Thanks', expect: [none] },
  { n: 21, text: 'AI wale sessions ab mangal aur jumeraat ko kar do', expect: [{ type: 'update_rule', goal: 'g_ai', rule: { weekdays: [2, 4] } }] },
  { n: 22, text: 'Add study block at 3', expect: [clarify] },
  { n: 23, text: 'Put case study on Tuesday at 9 for 2 hours', expect: [{ type: 'add_session', goal: 'g_case', start: '2026-10-27T09:00', min: 120 }] },
  { n: 24, text: 'raat 11 baje 30 minute reading', expect: [{ type: 'add_commitment', start: '2026-10-25T23:00', min: 30 }] },
  { n: 25, text: "Move tonight's lab to 8", expect: [{ type: 'move_session', session: 's_sun25', start: '2026-10-25T20:00' }] },
  { n: 26, text: 'Cancel everything tomorrow', expect: [{ type: 'cancel_session', session: 's_mon26' }, clarify] },
  { n: 27, text: 'budh ko 6 baje gym, juma ko bhi', expect: [{ type: 'add_commitment', start: '2026-10-28T18:00', min: 60 }, { type: 'add_commitment', start: '2026-10-30T18:00', min: 60 }] },
  { n: 28, text: 'Add a new goal: learn Spanish by March', expect: [none] },
  { n: 29, text: 'Paune 9 baje case study', expect: [clarify] },
  { n: 30, text: 'Move the gym', expect: [clarify] },
  { n: 31, text: 'sawa 7 baje subah walk add karo har roz', expect: [{ type: 'add_commitment', start: '2026-10-26T07:15', min: 60, repeat: [0, 1, 2, 3, 4, 5, 6] }] },
  { n: 32, text: 'Lab ko kal shift kar do same time', expect: [{ type: 'move_session', session: 's_sun25', start: '2026-10-26T18:00' }] },
  { n: 33, text: 'Delete the doctor visit', expect: [clarify] },
  { n: 34, text: 'I want to start my AI session now', expect: [none] },
  { n: 35, text: 'Mere Monday ke AI session ko 30 minute late kar do', expect: [{ type: 'move_session', session: 's_mon26', start: '2026-10-26T20:30' }] },
  { n: 36, text: 'Add gym next Sunday 6 pm', expect: [{ type: 'add_commitment', start: '2026-11-01T18:00', min: 60 }] },
  { n: 37, text: 'Block Friday evening for family', expect: [clarify] },
  { n: 38, text: 'Kal subah 9 se 11 tak kaam', expect: [{ type: 'add_commitment', start: '2026-10-26T09:00', min: 120 }] },
  { n: 39, text: "Move Saturday's missed session to Monday 6 pm", expect: [{ type: 'add_session', goal: 'g_ai', start: '2026-10-26T18:00', min: 90 }] },
  { n: 40, text: 'asdf qwerty', expect: [clarify] },
];

const MUTATING = new Set(['add_commitment', 'add_session', 'move_session', 'cancel_session', 'delete_commitment', 'update_rule']);
const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

function matches(e: Expect, a: PlanAction): boolean {
  if (e.type !== a.type) return false;
  switch (e.type) {
    case 'clarify':
    case 'none':
      return true;
    case 'add_commitment':
      return a.start_local === e.start && (a.duration_min ?? 60) === e.min && sameSet(a.repeat_weekdays ?? [], e.repeat ?? []);
    case 'add_session': {
      const goal = EVAL_GOALS.find((g) => g.id === a.goal_id);
      return a.goal_id === e.goal && a.start_local === e.start && (a.duration_min ?? goal?.rule.duration_min) === e.min;
    }
    case 'move_session':
      return a.session_id === e.session && a.start_local === e.start;
    case 'cancel_session':
      return a.session_id === e.session;
    case 'delete_commitment': {
      const scope = a.scope ?? (a.start_local ? 'one' : 'series');
      if (a.commitment_id !== e.commitment || scope !== e.scope) return false;
      // one occurrence: the day decides which one (its time comes from the commitment)
      return e.scope === 'series' || a.start_local?.slice(0, 10) === e.date;
    }
    case 'update_rule': {
      const goal = EVAL_GOALS.find((g) => g.id === e.goal);
      if (!goal || a.goal_id !== e.goal) return false;
      const got = { ...goal.rule, ...stripUndefined(a.rule ?? {}) };
      const want = { ...goal.rule, ...e.rule };
      return sameSet(got.weekdays, want.weekdays) && got.start_time === want.start_time &&
        got.duration_min === want.duration_min && got.lead_min === want.lead_min;
    }
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Order-insensitive: every expected action matched by a distinct one, no extra changes. */
export function scorePlan(c: EvalCase, plan: Plan): boolean {
  const expectChanges = c.expect.some((e) => MUTATING.has(e.type));
  const got = plan.actions.filter((a) => a.type !== 'none' || !expectChanges);
  const onlyNone = c.expect.length === 1 && c.expect[0].type === 'none';
  if (onlyNone) return got.every((a) => a.type === 'none');
  const onlyClarify = c.expect.every((e) => e.type === 'clarify');
  if (onlyClarify) return got.some((a) => a.type === 'clarify') && got.every((a) => !MUTATING.has(a.type));
  const used = new Set<number>();
  for (const e of c.expect) {
    const i = got.findIndex((a, idx) => !used.has(idx) && matches(e, a));
    if (i < 0) return false;
    used.add(i);
  }
  return got.every((a, idx) => used.has(idx) || !MUTATING.has(a.type));
}

export interface EvalResult {
  n: number;
  text: string;
  pass: boolean;
  expected: Expect[];
  got: Partial<PlanAction>[];
  reply?: string;
  attempts?: number;
  model?: string | null;
  error?: string;
  ms: number;
}

const compact = (a: PlanAction): Partial<PlanAction> => stripUndefined({
  type: a.type,
  goal_id: a.goal_id,
  session_id: a.session_id,
  commitment_id: a.commitment_id,
  start_local: a.start_local,
  duration_min: a.duration_min,
  repeat_weekdays: a.repeat_weekdays,
  scope: a.scope,
  rule: a.rule,
  question: a.question,
  options: a.options,
}) as Partial<PlanAction>;

export async function runEval(numbers?: number[]): Promise<{ results: EvalResult[]; passed: number; total: number }> {
  const cases = numbers?.length ? EVAL_CASES.filter((c) => numbers.includes(c.n)) : EVAL_CASES;
  const results: EvalResult[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const { plan, attempts, model } = await planWithLlm(c.text, EVAL_CONTEXT);
      results.push({
        n: c.n, text: c.text, pass: scorePlan(c, plan), expected: c.expect, got: plan.actions.map(compact),
        reply: plan.reply_text, attempts, model, ms: Date.now() - t0,
      });
    } catch (err) {
      results.push({
        n: c.n, text: c.text, pass: false, expected: c.expect, got: [],
        error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0,
      });
    }
  }
  return { results, passed: results.filter((r) => r.pass).length, total: results.length };
}
