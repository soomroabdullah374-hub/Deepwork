import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  type CallAction,
  callContext,
  CallReplySchema,
  callSystemPrompt,
  holdOffer,
  pickFreeTimes,
  callUserMessage,
  runCallAction,
} from '../_shared/assistant/call.ts';
import { HttpError } from '../_shared/http.ts';
import type { AppState } from '../_shared/state.ts';
import { makeState, NOW, S_SUN25 } from './fixtures.ts';

// The call is about Sunday's Cloud lab at 18:00, 45 minutes after NOW (17:15 Karachi).
const action = (a: Partial<CallAction>): CallAction => ({ type: 'none', minutes: null, date: null, time: null, title: null, request: null, ...a });

function fakeCallDb(opts: { clash?: boolean; free?: string[] } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    // deno-lint-ignore require-await
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ fn, args });
      if (fn === 'free_slots') return (opts.free ?? []).map((starts_at) => ({ starts_at })) as T;
      const busy = (fn === 'block_action' && (args.p_action === 'move' || args.p_action === 'snooze')) || fn === 'save_commitment';
      if (opts.clash && busy) {
        throw new HttpError(409, 'clash', 'That time is taken.', {
          with: { title: 'Training class', starts_at: '2026-10-26T09:00:00Z', ends_at: '2026-10-26T12:00:00Z' },
        });
      }
      return {} as T;
    },
    // deno-lint-ignore require-await
    async insert<T>(table: string, row: Record<string, unknown>): Promise<T> {
      calls.push({ fn: `insert ${table}`, args: row });
      return { id: '30000000-0000-4000-8000-000000000009' } as T;
    },
  };
}

function setup(romanUrdu = false) {
  const state: AppState = makeState();
  if (romanUrdu) state.profile = { ...state.profile, language: 'ur-Latn' };
  const block = state.blocks.find((b) => b.id === S_SUN25)!;
  return { state, block };
}

Deno.test('the call knows the session, the time left and what else is on', () => {
  const { state, block } = setup(true);
  const c = callContext(state, block, NOW, ['2026-10-25T16:30:00Z']);
  assertEquals(c.romanUrdu, true);
  assertEquals(c.session.minutesUntil, 45);
  assertEquals(c.session.when, 'today 18:00–19:00');
  assertEquals(c.freeTimes, ['today 21:30']);
  assert(!c.around.some((line) => line.includes('Cloud Data Engineering labs')), 'the session itself is not "also on"');
  const prompt = callSystemPrompt(c);
  assertStringIncludes(prompt, 'Roman Urdu');
  assertStringIncludes(prompt, 'starts in 45 minutes');
  assertStringIncludes(prompt, 'Urdu script');
  assertStringIncludes(callSystemPrompt({ ...c, romanUrdu: false }), 'simple, friendly English');
});

Deno.test('the first turn opens the call; later turns carry the whole call', () => {
  assertStringIncludes(callUserMessage([], null), 'just answered');
  const msg = callUserMessage([{ who: 'agent', text: 'Salam! Session 6 baje hai.' }, { who: 'user', text: 'haan' }], 'das minute baad');
  assertStringIncludes(msg, 'You: Salam! Session 6 baje hai.');
  assertStringIncludes(msg, 'They: haan');
  assertStringIncludes(msg, 'They now say: "das minute baad"');
});

Deno.test('model output is normalised, not thrown away', () => {
  const r = CallReplySchema.parse({
    heard: 'das minute baad',
    reply: '  Theek hai, das minute baad.  ',
    action: { type: 'later', minutes: 10, date: null, time: '8:30', request: null },
    end_call: 'yes',
  });
  assertEquals(r.reply, 'Theek hai, das minute baad.');
  assertEquals(r.action.type, 'none');
  assertEquals(r.action.time, '08:30');
  assertEquals(r.end_call, false);
  assertEquals(r.reply_voice, '');
});

Deno.test('start, later, skip and done go straight to the session', async () => {
  const { state, block } = setup();
  for (const [a, expected] of [
    [action({ type: 'start' }), { p_action: 'start', p: {} }],
    [action({ type: 'snooze', minutes: 200 }), { p_action: 'snooze', p: { minutes: 120 } }],
    [action({ type: 'snooze' }), { p_action: 'snooze', p: { minutes: 10 } }],
    [action({ type: 'skip' }), { p_action: 'skip', p: { reason: 'Skipped on the reminder call' } }],
    [action({ type: 'done' }), { p_action: 'finish', p: {} }],
  ] as const) {
    const db = fakeCallDb();
    const out = await runCallAction(a, { db, state, block, now: NOW });
    assertEquals(out.ok, true);
    assertEquals(out.changed, true);
    assertEquals(db.calls, [{ fn: 'block_action', args: { p_id: block.id, ...expected } }]);
  }
});

Deno.test('another time is local time; a taken time comes back as a problem to explain', async () => {
  const { state, block } = setup();
  const db = fakeCallDb();
  const out = await runCallAction(action({ type: 'move', date: '2026-10-25', time: '21:30' }), { db, state, block, now: NOW });
  assertEquals(out.ok, true);
  assertEquals(db.calls[0].args, { p_id: block.id, p_action: 'move', p: { starts_at: '2026-10-25T16:30:00.000Z' } });

  // 10:00 Karachi tomorrow is taken: the agent hears what, and the free times just before and after
  const busy = fakeCallDb({
    clash: true,
    free: ['2026-10-26T03:00:00Z', '2026-10-26T04:00:00Z', '2026-10-26T06:00:00Z', '2026-10-26T07:00:00Z'],
  });
  const clash = await runCallAction(action({ type: 'move', date: '2026-10-26', time: '10:00' }), { db: busy, state, block, now: NOW });
  assertEquals(clash.ok, false);
  assertEquals(clash.changed, false);
  assertEquals(clash.problem, 'that time is taken by Training class (tomorrow 14:00–17:00); free near then: tomorrow 09:00, tomorrow 11:00');
  const asked = busy.calls.find((c) => c.fn === 'free_slots')!.args;
  assertEquals([asked.p_duration_min, asked.p_ignore, asked.p_step_min], [60, block.id, 15]);

  // nothing free nearby: just the clash
  const full = await runCallAction(action({ type: 'move', date: '2026-10-26', time: '10:00' }), { db: fakeCallDb({ clash: true }), state, block, now: NOW });
  assertEquals(full.problem, 'that time is taken by Training class (tomorrow 14:00–17:00)');

  const missing = await runCallAction(action({ type: 'move', date: '2026-10-26' }), { db, state, block, now: NOW });
  assertEquals(missing.ok, false);
});

Deno.test('a session that is already done is not started again', async () => {
  const { state, block } = setup();
  const db = fakeCallDb();
  const out = await runCallAction(action({ type: 'start' }), { db, state, block: { ...block, status: 'done' }, now: NOW });
  assertEquals(out, { ok: true, changed: false });
  assertEquals(db.calls.length, 0);
});

Deno.test('free times on offer: the soonest, and the one nearest the same time tomorrow', () => {
  // the session is today 18:00 Karachi (13:00Z)
  const block = { starts_at: '2026-10-25T13:00:00Z' };
  const free = [
    '2026-10-26T15:30:00Z', // tomorrow 20:30
    '2026-10-25T16:30:00Z', // today 21:30
    '2026-10-26T03:00:00Z', // tomorrow 08:00
    '2026-10-25T17:00:00Z', // today 22:00
    '2026-10-26T12:30:00Z', // tomorrow 17:30, nearest to 18:00
    '2026-10-26T13:30:00Z', // tomorrow 18:30
  ];
  assertEquals(pickFreeTimes(free, block), [
    '2026-10-25T16:30:00Z',
    '2026-10-25T17:00:00Z',
    '2026-10-26T03:00:00Z',
    '2026-10-26T12:30:00Z',
  ]);
  // nothing within 3 hours of that time tomorrow (22:30 is 4.5 hours off): just the soonest
  const later = ['2026-10-25T16:30:00Z', '2026-10-26T03:00:00Z', '2026-10-25T17:00:00Z', '2026-10-26T17:30:00Z'];
  assertEquals(pickFreeTimes(later, block), ['2026-10-25T16:30:00Z', '2026-10-25T17:00:00Z', '2026-10-26T03:00:00Z']);
  assertEquals(pickFreeTimes([], block), []);
});

Deno.test('adding something once is saved straight away as a one-off commitment', async () => {
  const { state, block } = setup();
  const db = fakeCallDb();
  const gym = action({ type: 'add', title: 'Gym', date: '2026-10-26', time: '19:00', minutes: null });
  assertEquals(await runCallAction(gym, { db, state, block, now: NOW }), { ok: true, changed: true });
  assertEquals(db.calls, [{
    fn: 'save_commitment',
    args: { p: { title: 'Gym', weekdays: [], start_time: '19:00', duration_min: 60, one_off_date: '2026-10-26', starts_on: null } },
  }]);

  // a taken time: what is in the way, and the free times either side for that length
  const busy = fakeCallDb({ clash: true, free: ['2026-10-26T08:00:00Z', '2026-10-26T12:30:00Z', '2026-10-26T15:00:00Z'] });
  const out = await runCallAction(action({ ...gym, minutes: 45 }), { db: busy, state, block, now: NOW });
  assertEquals(out.ok, false);
  assertEquals(out.problem, 'that time is taken by Training class (tomorrow 14:00–17:00); free near then: tomorrow 17:30, tomorrow 20:00');
  const asked = busy.calls.find((c) => c.fn === 'free_slots')!.args;
  assertEquals([asked.p_duration_min, asked.p_ignore], [45, null]);

  // nothing is saved without a title, a day and a time, or in the past
  for (const bad of [{ title: null }, { date: null }, { time: '16:00', date: '2026-10-25' }]) {
    const none = fakeCallDb();
    const r = await runCallAction(action({ ...gym, ...bad }), { db: none, state, block, now: NOW });
    assertEquals(r.ok, false);
    assertEquals(none.calls.length, 0);
  }
});

Deno.test('a reply that offers something waits for the yes', () => {
  const reply = (text: string, type: CallAction['type']) =>
    CallReplySchema.parse({ heard: '', reply: text, reply_voice: '', action: action({ type, date: '2026-10-26', time: '20:45' }), end_call: true });
  const held = holdOffer(reply('Kal 7 baje gym hai, 8:45 baje free hai, kya 8:45 par kar dein?', 'move'));
  assertEquals([held.action.type, held.end_call], ['none', false]);
  assertEquals(holdOffer(reply('Shall I move it to 8:45 tonight?', 'move')).action.type, 'none');
  assertEquals(holdOffer(reply('Gym add kar doon?', 'add')).action.type, 'none');
  // done and said so: it stays done, even with a question after it
  assertEquals(holdOffer(reply('Theek hai, kal shaam 8 baje kar diya.', 'move')).action.type, 'move');
  assertEquals(holdOffer(reply('Theek hai, das minute baad kar diya. Aur kuch?', 'snooze')).action.type, 'snooze');
  assertEquals(holdOffer(reply('Theek hai, kal 8 baje kar lete hain.', 'move')).action.type, 'move');
});
