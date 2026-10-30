import { assert, assertEquals } from 'jsr:@std/assert@1';
import { PlanSchema } from '../_shared/assistant/schema.ts';

const action = (over: Record<string, unknown>) => ({
  type: 'add_commitment',
  summary: 'Add Gym',
  title: null,
  goal_id: null,
  session_id: null,
  commitment_id: null,
  start_local: null,
  duration_min: null,
  repeat_weekdays: null,
  scope: null,
  rule: null,
  question: null,
  options: null,
  expect_free: null,
  ...over,
});

Deno.test('plan validation normalises small slips', () => {
  const plan = PlanSchema.parse({
    reply_language: 'en',
    reply_text: 'x'.repeat(400),
    reply_tts: 'ok',
    actions: [
      action({ title: 'Gym', start_local: '2026-10-26 19:00:00', duration_min: 2000, repeat_weekdays: [7, 0, 3] }),
      action({ type: 'update_rule', goal_id: 'g', rule: { weekdays: [], start_time: '8:30', duration_min: null, lead_min: null } }),
      action({ type: 'clarify', question: 'Which day?', options: ['a', 'b', 'c', 'd'] }),
    ],
  });
  assertEquals(plan.reply_text.length, 280);
  const [add, rule, ask] = plan.actions;
  assertEquals(add.start_local, '2026-10-26T19:00');
  assertEquals(add.duration_min, 1440);
  assertEquals(add.repeat_weekdays, [0, 3]);
  assertEquals(add.goal_id, undefined);
  assertEquals(rule.rule?.weekdays, undefined);
  assertEquals(rule.rule?.start_time, '08:30');
  assertEquals(ask.options?.length, 3);
});

Deno.test('plan validation rejects what cannot be repaired', () => {
  assert(!PlanSchema.safeParse({ reply_language: 'fr', reply_text: '', reply_tts: '', actions: [] }).success);
  assert(!PlanSchema.safeParse({
    reply_language: 'en', reply_text: '', reply_tts: '', actions: [action({ start_local: 'tomorrow 7pm' })],
  }).success);
  assert(!PlanSchema.safeParse({
    reply_language: 'en', reply_text: '', reply_tts: '', actions: [action({ type: 'delete_everything' })],
  }).success);
});
