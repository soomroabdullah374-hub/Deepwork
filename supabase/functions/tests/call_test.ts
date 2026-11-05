import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  askedMove,
  type CallAction,
  callContext,
  CallReplySchema,
  callSystemPrompt,
  holdOffer,
  matchOffered,
  offeredFrom,
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
  assertEquals(clash.offered, ['2026-10-26T09:00', '2026-10-26T11:00']);
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

Deno.test('free times on offer: the soonest an hour apart, and the one nearest the same time tomorrow', () => {
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
  // 22:00 is only half an hour after 21:30, so the next one is tomorrow 08:00
  assertEquals(pickFreeTimes(free, block), ['2026-10-25T16:30:00Z', '2026-10-26T03:00:00Z', '2026-10-26T12:30:00Z']);
  // the soonest three, then tomorrow 17:30 for "kal isi waqt"
  const spread = ['2026-10-25T16:30:00Z', '2026-10-26T03:00:00Z', '2026-10-26T05:00:00Z', '2026-10-26T12:30:00Z'];
  assertEquals(pickFreeTimes(spread, block), spread);
  // nothing within 3 hours of that time tomorrow (22:30 is 4.5 hours off): just the soonest
  const later = ['2026-10-25T16:30:00Z', '2026-10-26T03:00:00Z', '2026-10-26T05:00:00Z', '2026-10-26T17:30:00Z'];
  assertEquals(pickFreeTimes(later, block), ['2026-10-25T16:30:00Z', '2026-10-26T03:00:00Z', '2026-10-26T05:00:00Z']);
  assertEquals(pickFreeTimes([], block), []);
  // every 15 minutes free: an hour apart, not 21:30, 21:45, 22:00
  const quarterHours = ['2026-10-25T16:30:00Z', '2026-10-25T16:45:00Z', '2026-10-25T17:00:00Z', '2026-10-25T17:30:00Z', '2026-10-26T02:00:00Z'];
  assertEquals(pickFreeTimes(quarterHours, block), ['2026-10-25T16:30:00Z', '2026-10-25T17:30:00Z', '2026-10-26T02:00:00Z']);
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

Deno.test('"aath baje" after offering 6 or 8 pm tomorrow is the 8 pm that was offered', () => {
  const offered = offeredFrom({ run_id: '', summary: '', offered: ['2026-10-26T18:00', '2026-10-26T20:00', 'nonsense', 7] });
  assertEquals(offered, ['2026-10-26T18:00', '2026-10-26T20:00']);
  assertEquals(offeredFrom(null), []);
  assertEquals(offeredFrom({ run_id: 'x' }), []);

  const move = (date: string, time: string) => action({ type: 'move', date, time });
  // the model put today, or the morning: the 8 o'clock on offer is tomorrow evening
  assertEquals(matchOffered(move('2026-10-25', '20:00'), offered, 'Theek hai, aath baje kar do'), move('2026-10-26', '20:00'));
  assertEquals(matchOffered(move('2026-10-26', '08:00'), offered, 'aath baje'), move('2026-10-26', '20:00'));
  assertEquals(matchOffered(move('2026-10-26', '06:00'), offered, 'chhe baje kar do'), move('2026-10-26', '18:00'));
  // their own words name the day or the half of the day: they stand
  assertEquals(matchOffered(move('2026-10-26', '08:00'), offered, 'kal subah aath baje kar do'), move('2026-10-26', '08:00'));
  assertEquals(matchOffered(move('2026-10-25', '20:00'), offered, 'aaj aath baje'), move('2026-10-25', '20:00'));
  // nothing offered, no match, two matches, or not a time change: unchanged
  assertEquals(matchOffered(move('2026-10-25', '20:00'), [], 'aath baje'), move('2026-10-25', '20:00'));
  assertEquals(matchOffered(move('2026-10-26', '21:00'), offered, 'nau baje'), move('2026-10-26', '21:00'));
  assertEquals(matchOffered(move('2026-10-26', '08:00'), ['2026-10-26T08:00', '2026-10-27T20:00'], 'aath baje'), move('2026-10-26', '08:00'));
  assertEquals(matchOffered(action({ type: 'snooze', minutes: 10 }), offered, 'das minute').type, 'snooze');
});

Deno.test('the times just offered are in the prompt', () => {
  const { state, block } = setup(true);
  const c = callContext(state, block, NOW, [], ['2026-10-26T18:00', '2026-10-26T20:00']);
  assertEquals(c.offered, ['tomorrow 18:00', 'tomorrow 20:00']);
  assertStringIncludes(callSystemPrompt(c), 'You just offered: tomorrow 18:00, tomorrow 20:00.');
  assert(!callSystemPrompt({ ...c, offered: [] }).includes('You just offered'));
});

Deno.test('a time they asked for is checked by the app, not judged by the agent', () => {
  const reply = (over: Record<string, unknown>) =>
    CallReplySchema.parse({ heard: '', reply: '8 baje free nahi, 9 baje?', reply_voice: '', action: action({}), end_call: false, ...over });
  // the agent wrongly thought 8 pm was taken: the app tries it
  assertEquals(askedMove(reply({ asked_date: '2026-10-26', asked_time: '20:00' }), [], 'kal aath baje kar do'), action({ type: 'move', date: '2026-10-26', time: '20:00' }));
  // a bare "aath baje" after offering 6 or 8 pm tomorrow is the 8 pm offered
  assertEquals(
    askedMove(reply({ asked_date: '2026-10-25', asked_time: '8:00' }), ['2026-10-26T18:00', '2026-10-26T20:00'], 'aath baje kar do'),
    action({ type: 'move', date: '2026-10-26', time: '20:00' }),
  );
  // nothing asked, or the agent already acted: nothing to check
  assertEquals(askedMove(reply({}), [], 'theek hai'), null);
  assertEquals(askedMove(reply({ asked_date: '2026-10-26', asked_time: null }), [], 'kal'), null);
  assertEquals(askedMove(reply({ asked_date: '2026-10-26', asked_time: '20:00', action: action({ type: 'move', date: '2026-10-26', time: '20:00' }) }), [], 'x'), null);
  // what the model reports is cleaned like the rest of its answer
  assertEquals(reply({ asked_date: 'tomorrow', asked_time: '8' }).asked_date, null);
  assertEquals(reply({ asked_time: '8:30' }).asked_time, '08:30');
});

Deno.test('an English call gets English examples, a Roman Urdu call Roman Urdu ones', () => {
  const { state, block } = setup();
  const english = callSystemPrompt(callContext(state, block, NOW, [], ['2026-10-26T20:00']));
  assertEquals(english.match(/\b(theek hai|kar diya|kar doon|baje|subah|shaam|haan|dekhta|pehla wala)\b/gi), null);
  assertStringIncludes(english, 'Shall I move it to 8?');
  const urdu = callSystemPrompt(callContext(setup(true).state, block, NOW, [], ['2026-10-26T20:00']));
  assertStringIncludes(urdu, 'Theek hai, session 10 minute baad kar diya');
  assertStringIncludes(urdu, 'subah ya shaam?');
});
