import { assert, assertEquals } from 'jsr:@std/assert@1';
import { EVAL_CASES, scorePlan } from '../_shared/assistant/eval.ts';
import { type Plan, PlanSchema } from '../_shared/assistant/schema.ts';

// Builds the plan a perfect model would return for a case, from its expectation.
function ideal(c: (typeof EVAL_CASES)[number]): Plan {
  const actions = c.expect.map((e) => {
    switch (e.type) {
      case 'clarify':
        return { type: 'clarify', summary: 'Q', question: 'Which one?', options: ['A', 'B'] };
      case 'none':
        return { type: 'none', summary: 'Reply' };
      case 'add_commitment':
        return { type: 'add_commitment', summary: 'Add', title: 'X', start_local: e.start, duration_min: e.min, repeat_weekdays: e.repeat ?? null };
      case 'add_session':
        return { type: 'add_session', summary: 'Add', goal_id: e.goal, start_local: e.start, duration_min: e.min };
      case 'move_session':
        return { type: 'move_session', summary: 'Move', session_id: e.session, start_local: e.start };
      case 'cancel_session':
        return { type: 'cancel_session', summary: 'Cancel', session_id: e.session };
      case 'delete_commitment':
        return { type: 'delete_commitment', summary: 'Delete', commitment_id: e.commitment, scope: e.scope, start_local: e.date ? `${e.date}T14:00` : null };
      case 'update_rule':
        return { type: 'update_rule', summary: 'Rule', goal_id: e.goal, rule: { weekdays: null, start_time: null, duration_min: null, lead_min: null, ...e.rule } };
    }
  });
  return PlanSchema.parse({ reply_language: 'en', reply_text: '', reply_tts: '', actions });
}

Deno.test('the eval has 40 cases and a perfect plan scores 40/40', () => {
  assertEquals(EVAL_CASES.length, 40);
  for (const c of EVAL_CASES) assert(scorePlan(c, ideal(c)), `case ${c.n} should pass with its ideal plan`);
});

Deno.test('the scorer catches wrong times, ids and extra changes', () => {
  const c3 = EVAL_CASES.find((c) => c.n === 3)!;
  const wrongTime = ideal(c3);
  wrongTime.actions[0].start_local = '2026-10-29T08:00';
  assert(!scorePlan(c3, wrongTime));

  const c5 = EVAL_CASES.find((c) => c.n === 5)!;
  const wrongId = ideal(c5);
  wrongId.actions[0].session_id = 's_mon26';
  assert(!scorePlan(c5, wrongId));

  const c1 = EVAL_CASES.find((c) => c.n === 1)!; // expects a question, not a guess
  const guessed = ideal(EVAL_CASES.find((c) => c.n === 2)!);
  assert(!scorePlan(c1, guessed));

  // a rhythm change written out in full counts the same as only the changed field
  const c11 = EVAL_CASES.find((c) => c.n === 11)!;
  const full = ideal(c11);
  full.actions[0].rule = { weekdays: [1, 3, 6], start_time: '20:00', duration_min: 120, lead_min: 10 };
  assert(scorePlan(c11, full));
});
