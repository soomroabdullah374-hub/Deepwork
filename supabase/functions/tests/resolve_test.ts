import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { isAutoApplicable, resolvePlan } from '../_shared/assistant/resolve.ts';
import { type Plan, PlanSchema } from '../_shared/assistant/schema.ts';
import { C_CLASS, fakeDb, G_AI, G_CASE, makeState, NOW, S_MON26, S_SUN25, S_WED28, TZ } from './fixtures.ts';

const plan = (...actions: Record<string, unknown>[]): Plan =>
  PlanSchema.parse({
    reply_language: 'en',
    reply_text: 'ok',
    reply_tts: 'ok',
    actions: actions.map((a) => ({ summary: '', ...a })),
  });

async function resolve(p: Plan) {
  const state = makeState();
  return await resolvePlan(p, { state, tz: TZ, now: NOW }, fakeDb(state));
}

Deno.test('a free one-off commitment is ok, in UTC, with a friendly note', async () => {
  const [a] = await resolve(plan({ type: 'add_commitment', title: 'Gym', start_local: '2026-10-26T18:00', duration_min: 60 }));
  assertEquals(a.status, 'ok');
  assertEquals(a.starts_at, '2026-10-26T13:00:00.000Z');
  assertEquals(a.ends_at, '2026-10-26T14:00:00.000Z');
  assertEquals(a.local_date, '2026-10-26');
  assertEquals(a.local_start_time, '18:00');
  assertEquals(a.when, 'Mon 26 Oct · 18:00–19:00');
  assertEquals(a.done_label, 'Gym, added Mon 18:00');
  assert(a.note?.startsWith('Free'));
});

Deno.test('a commitment on top of the class is a clash naming the class', async () => {
  const [a] = await resolve(plan({ type: 'add_commitment', title: 'Meeting', start_local: '2026-10-27T14:00' }));
  assertEquals(a.status, 'clash');
  assertEquals(a.clash?.title, 'Training class');
  assertStringIncludes(a.note ?? '', 'Tue 14:00–17:00 is Training class');
});

Deno.test('moving into another session clashes, moving within its own slot does not', async () => {
  const [onTop] = await resolve(plan({ type: 'move_session', session_id: S_MON26, start_local: '2026-10-28T21:00' }));
  assertEquals(onTop.status, 'clash');
  assertEquals(onTop.clash?.id, S_WED28);

  const [later] = await resolve(plan({ type: 'move_session', session_id: S_MON26, start_local: '2026-10-26T20:30' }));
  assertEquals(later.status, 'ok');
  assertEquals(later.duration_min, 90);
  assertEquals(later.when, 'Mon 26 · 20:00 → Mon 26 · 20:30');
});

Deno.test('a cancel in the same request frees its time for an add', async () => {
  const actions = await resolve(plan(
    { type: 'add_commitment', title: 'Gym', start_local: '2026-10-25T18:00', duration_min: 60 },
    { type: 'cancel_session', session_id: S_SUN25 },
  ));
  assertEquals(actions.map((a) => a.status), ['ok', 'ok']);
  assert(isAutoApplicable(actions));
});

Deno.test('two adds at the same time: the second one clashes with the first', async () => {
  const actions = await resolve(plan(
    { type: 'add_commitment', title: 'Gym', start_local: '2026-10-30T18:00' },
    { type: 'add_session', goal_id: G_CASE, start_local: '2026-10-30T18:30' },
  ));
  assertEquals(actions[0].status, 'ok');
  assertEquals(actions[1].status, 'clash');
  assertEquals(actions[1].clash?.title, 'Gym');
  assert(!isAutoApplicable(actions));
});

Deno.test('unknown ids, missing times and past times turn into questions', async () => {
  const [unknown, noTime, past] = await resolve(plan(
    { type: 'move_session', session_id: 'made-up', start_local: '2026-10-29T20:00' },
    { type: 'add_session', goal_id: G_AI },
    { type: 'add_commitment', title: 'Walk', start_local: '2026-10-25T07:00' },
  ));
  assertEquals(unknown.status, 'needs_answer');
  assertEquals(unknown.question, 'Which session should I move?');
  assertEquals(noTime.status, 'needs_answer');
  assertEquals(past.status, 'needs_answer');
  assertEquals(past.options, ['Tomorrow 07:00']);
});

Deno.test('a session added without a length uses the goal rhythm length', async () => {
  const [a] = await resolve(plan({ type: 'add_session', goal_id: G_AI, start_local: '2026-10-30T18:00' }));
  assertEquals(a.status, 'ok');
  assertEquals(a.duration_min, 90);
  assertEquals(a.title, 'Finish AI Agent portfolio project');
});

Deno.test('a weekly commitment checks every occurrence in the next two weeks', async () => {
  const [ok] = await resolve(plan({ type: 'add_commitment', title: 'Gym', start_local: '2026-11-01T19:00', repeat_weekdays: [0] }));
  assertEquals(ok.status, 'ok');
  assertEquals(ok.repeat_weekdays, [0]);
  assertStringIncludes(ok.when ?? '', 'Every Sun · 19:00–20:00');

  const [clash] = await resolve(plan({ type: 'add_commitment', title: 'Gym', start_local: '2026-10-26T14:30', repeat_weekdays: [1, 5] }));
  assertEquals(clash.status, 'clash');
  assertEquals(clash.clash?.title, 'Training class');
});

Deno.test('a rhythm change ignores the sessions it replaces', async () => {
  const [a] = await resolve(plan({ type: 'update_rule', goal_id: G_AI, rule: { weekdays: [2, 4] } }));
  assertEquals(a.status, 'ok');
  assertEquals(a.rule, { weekdays: [2, 4], start_time: '20:00', duration_min: 90, lead_min: 10 });
  assertStringIncludes(a.note ?? '', 'sessions in the next 2 weeks');

  const [clash] = await resolve(plan({ type: 'update_rule', goal_id: G_AI, rule: { start_time: '15:00' } }));
  assertEquals(clash.status, 'clash');
  assertEquals(clash.clash?.title, 'Training class');
});

Deno.test('one occurrence of a commitment is found by its day', async () => {
  const [one, series, missing] = await resolve(plan(
    { type: 'delete_commitment', commitment_id: C_CLASS, scope: 'one', start_local: '2026-10-29T14:00' },
    { type: 'delete_commitment', commitment_id: C_CLASS, scope: 'series' },
    { type: 'delete_commitment', commitment_id: C_CLASS, scope: 'one', start_local: '2026-10-30T14:00' },
  ));
  assertEquals(one.status, 'ok');
  assert(one.occurrence_id);
  assertEquals(series.status, 'ok');
  assertEquals(series.scope, 'series');
  assertEquals(missing.status, 'invalid');
});

Deno.test('clarify and none pass through', async () => {
  const [ask, info] = await resolve(plan(
    { type: 'clarify', question: 'Which time?', options: ['18:00', '20:00'] },
    { type: 'none' },
  ));
  assertEquals(ask.status, 'needs_answer');
  assertEquals(ask.options, ['18:00', '20:00']);
  assertEquals(info.status, 'info');
  assert(!isAutoApplicable([info]));
});
