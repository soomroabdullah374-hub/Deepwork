// The reminder call. When a session's reminder went unanswered, the phone rings and this
// agent talks it through like a friend on the phone: Roman Urdu (or English), one or two
// short sentences a turn, and at most one action per turn, carried out right here: start,
// a little later, another time, skip, already done, add something once, or any other
// change (the agent asks first; on their yes it is saved, other changes through the
// assistant's planner). The app keeps the
// conversation and sends it back every turn, so the server stores nothing about the call.

import { z } from 'npm:zod@3.25.76';
import { config } from '../env.ts';
import { HttpError } from '../http.ts';
import type { Db } from '../neon.ts';
import type { AppState, Block } from '../state.ts';
import { addDays, daysBetween, localDate, localTime, localToUtc, minutesBetween, weekdayOf, WEEKDAYS_LONG } from '../time.ts';
import { type ChatMessage, chatJson, type ChatOptions } from './llm.ts';
import { planWithLlm, promptContext } from './planner.ts';
import { MUTATING_TYPES, resolvePlan } from './resolve.ts';

export const CALL_ACTIONS = ['none', 'start', 'snooze', 'move', 'skip', 'done', 'add', 'change'] as const;
export type CallActionType = (typeof CALL_ACTIONS)[number];

export interface CallLine {
  who: 'agent' | 'user';
  text: string;
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const CALL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['heard', 'asked_date', 'asked_time', 'reply', 'reply_voice', 'action', 'end_call'],
  properties: {
    heard: { type: 'string' },
    asked_date: nullable({ type: 'string' }),
    asked_time: nullable({ type: 'string' }),
    reply: { type: 'string' },
    reply_voice: { type: 'string' },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'minutes', 'date', 'time', 'title', 'request'],
      properties: {
        type: { type: 'string', enum: [...CALL_ACTIONS] },
        minutes: nullable({ type: 'integer' }),
        date: nullable({ type: 'string' }),
        time: nullable({ type: 'string' }),
        title: nullable({ type: 'string' }),
        request: nullable({ type: 'string' }),
      },
    },
    end_call: { type: 'boolean' },
  },
} as const;

const text = (max: number) => z.string().catch('').transform((s) => s.trim().slice(0, max));

const clock = z.string().regex(/^\d{1,2}:\d{2}/).transform((t) => t.padStart(5, '0').slice(0, 5));

export const CallReplySchema = z.object({
  heard: text(300).default(''),
  asked_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().catch(null),
  asked_time: clock.nullish().catch(null),
  reply: text(400),
  reply_voice: text(400).default(''),
  action: z
    .object({
      type: z.enum(CALL_ACTIONS).catch('none'),
      minutes: z.number().int().nullish().catch(null),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().catch(null),
      time: clock.nullish().catch(null),
      title: z.string().transform((t) => t.trim().slice(0, 80)).nullish().catch(null),
      request: z.string().nullish().catch(null),
    })
    .catch({ type: 'none', minutes: null, date: null, time: null, title: null, request: null }),
  end_call: z.boolean().catch(false),
});
export type CallReply = z.infer<typeof CallReplySchema>;
export type CallAction = CallReply['action'];

export interface CallContext {
  romanUrdu: boolean;
  name: string;
  now: string; // "Wednesday 4 Nov, 19:52"
  session: {
    title: string;
    when: string; // "today 20:00–21:30"
    minutesUntil: number; // negative once it has started
    status: Block['status'];
    why: string | null;
  };
  around: string[]; // other blocks today and tomorrow
  freeTimes: string[]; // "today 21:30", "tomorrow 07:00"
  offered: string[]; // the times the agent just offered, "tomorrow 20:00"
}

const dayWord = (date: string, today: string) => {
  const d = daysBetween(today, date);
  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : `${WEEKDAYS_LONG[weekdayOf(date)]} ${date}`;
};

/** Everything the agent needs to know, in the person's local time. */
export function callContext(state: AppState, block: Block, now: Date, freeStarts: string[], offered: string[] = []): CallContext {
  const tz = state.profile.timezone;
  const today = localDate(now, tz);
  const goal = state.goals.find((g) => g.id === block.goal_id);
  const span = (b: Pick<Block, 'starts_at' | 'ends_at'>) =>
    `${dayWord(localDate(b.starts_at, tz), today)} ${localTime(b.starts_at, tz)}–${localTime(b.ends_at, tz)}`;
  const around = state.blocks
    .filter((b) => b.id !== block.id && b.status !== 'cancelled' && b.status !== 'skipped')
    .filter((b) => {
      const d = localDate(b.starts_at, tz);
      return d === today || d === addDays(today, 1);
    })
    .filter((b) => new Date(b.ends_at) > now)
    .slice(0, 8)
    .map((b) => `${span(b)} ${b.title}`);
  return {
    romanUrdu: state.profile.language === 'ur-Latn',
    name: state.profile.display_name?.trim() ?? '',
    now: `${WEEKDAYS_LONG[weekdayOf(today)]} ${today}, ${localTime(now, tz)}`,
    session: {
      title: state.profile.hide_titles ? 'your focus session' : block.title,
      when: span(block),
      minutesUntil: Math.round(minutesBetween(now, block.starts_at)),
      status: block.status,
      why: goal?.why ?? null,
    },
    around,
    freeTimes: freeStarts.map((s) => `${dayWord(localDate(s, tz), today)} ${localTime(s, tz)}`),
    offered: offered.map((o) => `${dayWord(o.slice(0, 10), today)} ${o.slice(11)}`),
  };
}

/**
 * Which free starts to offer: the soonest few, at least an hour apart, plus the one
 * closest to the session's own time tomorrow ("kal isi waqt").
 */
export function pickFreeTimes(starts: string[], block: Pick<Block, 'starts_at'>, soon = 3): string[] {
  const at = (s: string) => new Date(s).getTime();
  const sorted = starts.filter((s) => !Number.isNaN(at(s))).sort((x, y) => at(x) - at(y));
  const picked: string[] = [];
  for (const s of sorted) {
    if (picked.length === soon) break;
    if (!picked.length || at(s) - at(picked[picked.length - 1]) >= 3_600_000) picked.push(s);
  }
  const tomorrow = at(block.starts_at) + 24 * 3_600_000;
  let closest: string | null = null;
  for (const s of sorted) if (closest === null || Math.abs(at(s) - tomorrow) < Math.abs(at(closest) - tomorrow)) closest = s;
  if (closest && !picked.includes(closest) && Math.abs(at(closest) - tomorrow) <= 3 * 3_600_000) picked.push(closest);
  return picked;
}

export function callSystemPrompt(c: CallContext): string {
  // examples in their language, so an English call doesn't drift into Roman Urdu
  const ex = (urdu: string, english: string) => (c.romanUrdu ? urdu : english);
  const lang = c.romanUrdu
    ? 'Speak Roman Urdu (Urdu in English letters) the everyday way people in Pakistan talk on the phone, with the usual English words mixed in (session, time, start, break). Use polite "aap".'
    : 'Speak simple, friendly English.';
  const voice = c.romanUrdu
    ? '"reply_voice" is the same words in Urdu script for the Urdu voice, with times and numbers written as spoken ("ساڑھے آٹھ بجے", "دس منٹ"); English words may stay in English letters.'
    : '"reply_voice" is the same as "reply".';
  const until = c.session.minutesUntil >= 0
    ? `starts in ${c.session.minutesUntil} minute${c.session.minutesUntil === 1 ? '' : 's'}`
    : `started ${-c.session.minutesUntil} minutes ago`;
  return `You are DeepWork's reminder caller. DeepWork is ${c.name || "the person"}'s focus-session app. You are on a live phone call with them because a focus session is about to start and they did not answer its reminder.

How you talk:
- ${lang} If they answer in another language (English or Urdu), switch to theirs.
- Sound like a warm, caring friend, not a robot or a form. Short natural sentences, no lists, no markdown, no emojis.
- One or two sentences per reply, at most 25 words. Ask one thing at a time.
- ${c.romanUrdu ? 'Say times the way people say them: "shaam 7 baje", "raat 8 baje", "subah 9:30 baje", never "20:00".' : 'Say times the way people say them: "7 pm", "8:30 tonight", never "20:00".'}
- "reply" is what you say. ${voice}
- "heard" is what they just said, written ${c.romanUrdu ? 'in Roman Urdu' : 'in English'} (fix obvious transcription slips); empty on the first turn.
- "asked_date" and "asked_time": if in their latest words they ask for this session at a specific time (${ex('"kal aath baje kar do", "6 baje ho sakta hai?"', '"move it to 8 tomorrow", "can we do 6?"')}), that day (YYYY-MM-DD) and time (HH:MM, 24-hour), even if you think it is taken; otherwise null. The app checks that time itself.

The session: "${c.session.title}", ${c.session.when}; it ${until}. Status: ${c.session.status}.
${c.session.why ? `Why it matters to them (use it only briefly, to encourage): ${c.session.why}\n` : ''}Now: ${c.now}.
Also on their calendar: ${c.around.length ? c.around.join('; ') : 'nothing else today or tomorrow'}.
Free times for this session: ${c.freeTimes.length ? c.freeTimes.join(', ') : 'none found soon'}.${c.offered.length ? `\nYou just offered: ${c.offered.join(', ')}. If they pick one (${ex('"aath baje", "pehla wala"', '"8", "the first one"')}), use exactly that day and time.` : ''}

Put exactly one action in "action":
- start: they start the session now (or at its time).
- snooze: a little later; "minutes" from 5 to 120. The session itself moves, so say so: ${ex('"Theek hai, session 10 minute baad kar diya"', '"Okay, the session is now 10 minutes later"')} (not "reminder set").
- move: another time for this session; "date" (YYYY-MM-DD) and "time" (HH:MM, 24-hour). Never move it to a time they haven't said or agreed to.
- skip: not today.
- done: they already did it.
- add: they said yes to putting something else on their calendar once (gym, a class, an errand): "title" (short, e.g. "Gym"), "date", "time", and "minutes" (how long; 60 if they didn't say). It is checked and saved at once.
- change: they said yes to any other change to their schedule (move something else, change their weekly rhythm): write the whole request in plain English in "request", e.g. "Move Friday's gym to Saturday 6 pm". It is checked and saved at once.
- none: just talking, or you need to ask something.

Rules:
- The action you return is carried out at once. So never ask ${ex('"theek hai?"', '"okay?"')} or "confirm?" about it: say it is done, e.g. ${ex('"Theek hai, session 9:06 par kar diya."', '"Okay, the session is now at 9:06."')}
- snooze and move move the session itself (not just its reminder).
- Only the app knows what is free. Suggest only times from "Free times" (one or two), and never say a time is taken or clashes unless a note tells you so. When they name a time for the session, return move with exactly that time: it is checked, and if it is taken you will be told what is free near it.
- When you suggest or offer something (${ex('"8 baje kar doon?"', '"Shall I move it to 8?"')}), that is a question: action none, and wait for their yes.
- A time with no day means the day you were talking about. ${ex('"Aath baje"', '"At 8"')} while talking about the evening means 20:00; if morning or evening is unclear, ask (${ex('"subah ya shaam?"', '"morning or evening?"')}).
- If what they said is unclear, cut off, or doesn't answer you (a stray word like "you" or "hmm", noise), don't act: action none, and ask again in a few words.
- Never do an action again that you already did in this call, unless they clearly ask for it again.
- Act only on a clear decision. ${ex('"Haan", "theek hai", "kar do"', '"Yes", "okay", "do it"')} right after you suggested something is a clear yes to that suggestion, and so is repeating it loosely: after you offered tomorrow 20:00, ${ex('"theek hai, aath baje kar do"', '"okay, make it 8"')} means move it to tomorrow 20:00.
- Something else they ask for: if they clearly said what to add, the day and the time, do it now and say it back (${ex('"Theek hai, kal shaam 7 baje gym, ek ghante ke liye, add kar diya"', '"Okay, gym tomorrow at 7 pm for an hour is added"')}). If anything is missing or unclear, or it is a bigger change (like their weekly rhythm), first ask once (action none), e.g. ${ex('"Kal shaam 7 baje gym, ek ghante ke liye, add kar doon?"', '"Shall I add gym tomorrow at 7 pm for an hour?"')}, and on their yes return "add" or "change". If it can't be done you will be told why.
- If they are vague (${ex('"dekhta hoon", "pata nahi"', '"let me see", "not sure"')}), suggest one concrete option (start now, or one free time) and ask.
- After an action, say in a few words that it is done and end the call warmly (end_call true), unless they want something else.
- end_call true when they say bye, are busy, or want to hang up: say a short goodbye.
- First turn (they have not said anything yet): greet them${c.name ? ' by name' : ''}, say which session and how soon in a natural way, and ask if they are starting.`;
}

/** The call so far plus their latest words, as one message (the model sees the whole call). */
export function callUserMessage(history: CallLine[], said: string | null): string {
  if (!said && history.length === 0) return 'The call was just answered. They have not said anything yet.';
  const lines = history.map((l) => `${l.who === 'agent' ? 'You' : 'They'}: ${l.text}`).join('\n');
  return `${lines ? `The call so far:\n${lines}\n\n` : ''}They now say: "${said ?? ''}"`;
}

/** The times offered on the last turn, from the call's pending state the app sends back. */
export function offeredFrom(pending: unknown): string[] {
  const list = (pending as { offered?: unknown } | null)?.offered;
  if (!Array.isArray(list)) return [];
  return list.filter((o): o is string => typeof o === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o)).slice(0, 4);
}

// A day or part of the day: then they said which time they mean, so their words stand.
const WHEN = /\b(aaj|kal|parson|subah|dopahar|dopehar|shaam|sham|raat|today|tomorrow|tonight|morning|afternoon|evening|night|am|pm|monday|tuesday|wednesday|thursday|friday|saturday|sunday|peer|mangal|budh|jumerat|jumma|hafta|itwaar|itwar)\b/i;

/**
 * "Aath baje kar do" right after offering 6 or 8 pm tomorrow means the 8 pm that was
 * offered, whatever day or half of the day the model put on it.
 */
export function matchOffered(a: CallAction, offered: string[], said: string | null): CallAction {
  if ((a.type !== 'move' && a.type !== 'add') || !a.time || !offered.length || (said && WHEN.test(said))) return a;
  if (offered.includes(`${a.date}T${a.time}`)) return a;
  const [h, m] = a.time.split(':').map(Number);
  const hits = offered.filter((o) => {
    const [oh, om] = o.slice(11).split(':').map(Number);
    return oh % 12 === h % 12 && om === m;
  });
  return hits.length === 1 ? { ...a, date: hits[0].slice(0, 10), time: hits[0].slice(11) } : a;
}

/** What was already done on this call (action keys), from the pending state the app sends back. */
export function doneFrom(pending: unknown): string[] {
  const list = (pending as { done?: unknown } | null)?.done;
  return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string' && d.length <= 120).slice(-20) : [];
}

/** The same key twice means the same change twice. */
export function actionKey(a: CallAction): string | null {
  switch (a.type) {
    case 'start':
    case 'skip':
    case 'done':
    case 'snooze':
      return a.type;
    case 'move':
      return a.date && a.time ? `move@${a.date}T${a.time}` : null;
    case 'add':
      return a.title && a.date && a.time ? `add@${a.title.toLowerCase()}@${a.date}T${a.time}` : null;
    case 'change':
      return a.request ? `change@${a.request.toLowerCase().slice(0, 100)}` : null;
    default:
      return null;
  }
}

// A number or "again": they did ask for more ("aur das minute", "10 more minutes", "phir se").
const AGAIN = /\d|\b(das|paanch|panch|pandrah|bees|tees|aadha|aadhe|five|ten|fifteen|twenty|thirty|again|more|phir|dobara)\b/i;

/** "Theek hai" after a snooze is not another snooze: nothing is done twice in one call. */
export function holdRepeat(a: CallAction, done: string[], said: string | null): CallAction {
  const key = actionKey(a);
  if (!key || !done.includes(key)) return a;
  if (a.type === 'snooze' && said && AGAIN.test(said)) return a;
  return { ...a, type: 'none' };
}

/**
 * They asked for the session at a time and the agent didn't move it (often because it
 * thought the time was taken, and it is bad at working that out): the app checks that
 * time itself. Returns the move to try, or null.
 */
export function askedMove(r: CallReply, offered: string[], said: string | null): CallAction | null {
  if (r.action.type !== 'none' || !r.asked_date || !r.asked_time) return null;
  return matchOffered({ ...r.action, type: 'move', date: r.asked_date, time: r.asked_time }, offered, said);
}

// "... kar doon?", "Shall I move it?": an offer, not a decision.
const OFFER = /(kar (?:doon|dun|du|dein|den|dain|lein|len|lun|loon)|kar diya jaye|chah(?:e|ai)n ?ge|theek rahega|sahi rahega|shall i|should i|want me to|do you want|would you like)[^?.!]*\?/i;

/** A reply that offers to do something waits for their yes: nothing is done this turn. */
export function holdOffer(r: CallReply): CallReply {
  if (r.action.type === 'none' || !OFFER.test(r.reply)) return r;
  return { ...r, action: { ...r.action, type: 'none' }, end_call: false };
}

/** Someone is on the phone: never wait out a rate limit when another model can answer. */
const onTheLine = (opts: ChatOptions = {}): ChatOptions => ({ fallbackModel: config.llm.fallbackModel, ...opts });

export async function callReply(c: CallContext, history: CallLine[], said: string | null, note?: string): Promise<CallReply> {
  const messages: ChatMessage[] = [
    { role: 'system', content: callSystemPrompt(c) },
    { role: 'user', content: callUserMessage(history, said) },
  ];
  if (note) messages.push({ role: 'user', content: note });
  const out = await chatJson(
    messages,
    CALL_JSON_SCHEMA as unknown as Record<string, unknown>,
    'deepwork_call',
    // The provider counts the answer cap against its per-minute limit, so keep it close to what a turn needs.
    onTheLine({ reasoningEffort: 'low', maxTokens: 700, waitBudgetMs: 15_000 }),
  );
  const parsed = CallReplySchema.safeParse(out.data);
  if (!parsed.success || !parsed.data.reply) throw new HttpError(502, 'ai_failed', 'The call agent could not answer.');
  return holdOffer(parsed.data);
}

// ───────────────────────── carrying out what they decided

export interface Outcome {
  ok: boolean;
  /** Something in their schedule changed (the app refreshes). */
  changed: boolean;
  /** Why it could not be done, for the agent to explain. */
  problem?: string;
  /** Free times offered instead (local "YYYY-MM-DDTHH:MM"), kept by the app for the next turn. */
  offered?: string[];
  /** Said instead of the agent's line (the assistant's answer to a question about their week). */
  say?: { text: string; voice: string };
}

interface ClashDetail {
  title?: string;
  starts_at?: string;
  ends_at?: string;
}

function problemOf(err: unknown, tz: string, today: string): string {
  if (err instanceof HttpError) {
    const w = (err.extra?.with ?? null) as ClashDetail | null;
    if (err.code === 'clash' && w?.title) {
      const when = w.starts_at && w.ends_at
        ? ` (${dayWord(localDate(w.starts_at, tz), today)} ${localTime(w.starts_at, tz)}–${localTime(w.ends_at, tz)})`
        : '';
      return `that time is taken by ${w.title}${when}`;
    }
    return err.message;
  }
  return (err as Error).message ?? 'it could not be done';
}

export interface ActionInput {
  db: Pick<Db, 'rpc' | 'insert'>;
  state: AppState;
  block: Block;
  now: Date;
}

const LIVE = new Set<Block['status']>(['planned', 'snoozed', 'missed']);

export async function runCallAction(a: CallAction, input: ActionInput): Promise<Outcome> {
  const { db, state, block, now } = input;
  const tz = state.profile.timezone;
  const today = localDate(now, tz);
  const blockAction = (action: string, p: Record<string, unknown> = {}) =>
    db.rpc('block_action', { p_id: block.id, p_action: action, p });
  const done = (changed = true): Outcome => ({ ok: true, changed });
  try {
    switch (a.type) {
      case 'start':
        if (!LIVE.has(block.status)) return done(false);
        await blockAction('start');
        return done();
      case 'snooze':
        await blockAction('snooze', { minutes: Math.min(120, Math.max(5, a.minutes ?? 10)) });
        return done();
      case 'move': {
        if (!a.date || !a.time) return { ok: false, changed: false, problem: 'the day or time was missing' };
        const at = localToUtc(`${a.date}T${a.time}`, tz);
        try {
          await blockAction('move', { starts_at: at.toISOString() });
        } catch (err) {
          // say what is free just before and after the time they asked for
          const near = await freeNear(input, at, Math.round(minutesBetween(block.starts_at, block.ends_at)), block.id);
          return failedWithNear(problemOf(err, tz, today), near);
        }
        return done();
      }
      case 'skip':
        await blockAction('skip', { reason: 'Skipped on the reminder call' });
        return done();
      case 'done':
        await blockAction('finish');
        return done();
      case 'add': {
        const title = a.title?.trim();
        if (!title || !a.date || !a.time) return { ok: false, changed: false, problem: 'what to add, its day or its time was missing' };
        const at = localToUtc(`${a.date}T${a.time}`, tz);
        if (at.getTime() <= now.getTime()) return { ok: false, changed: false, problem: 'that time has already passed' };
        const minutes = Math.min(1440, Math.max(5, a.minutes ?? 60));
        try {
          await db.rpc('save_commitment', {
            p: { title, weekdays: [], start_time: a.time, duration_min: minutes, one_off_date: a.date, starts_on: null },
          });
        } catch (err) {
          return failedWithNear(problemOf(err, tz, today), await freeNear(input, at, minutes, null));
        }
        return done();
      }
      case 'change':
        return await planChange(a.request ?? '', input);
      default:
        return done(false);
    }
  } catch (err) {
    return { ok: false, changed: false, problem: problemOf(err, tz, today) };
  }
}

interface Near {
  local: string; // "2026-11-05T20:00"
  label: string; // "tomorrow 20:00"
}

const failedWithNear = (problem: string, near: Near[]): Outcome => ({
  ok: false,
  changed: false,
  problem: near.length ? `${problem}; free near then: ${near.map((n) => n.label).join(', ')}` : problem,
  offered: near.map((n) => n.local),
});

/** The free start closest before and closest after a time, for something this long. */
async function freeNear({ db, state, now }: ActionInput, at: Date, minutes: number, ignore: string | null): Promise<Near[]> {
  const tz = state.profile.timezone;
  const hour = 3_600_000;
  try {
    const slots = await db.rpc<{ starts_at: string }[]>('free_slots', {
      p_duration_min: minutes,
      p_from: new Date(Math.max(now.getTime(), at.getTime() - 4 * hour)).toISOString(),
      p_to: new Date(at.getTime() + 5 * hour).toISOString(),
      p_limit: 60,
      p_ignore: ignore,
      p_step_min: 15,
    });
    if (!Array.isArray(slots)) return [];
    const times = slots.map((s) => new Date(s.starts_at)).filter((d) => !Number.isNaN(d.getTime()));
    const before = times.filter((d) => d < at).sort((x, y) => y.getTime() - x.getTime())[0];
    const after = times.filter((d) => d > at).sort((x, y) => x.getTime() - y.getTime())[0];
    const today = localDate(now, tz);
    return [before, after].filter((d): d is Date => !!d).map((d) => ({
      local: `${localDate(d, tz)}T${localTime(d, tz)}`,
      label: `${dayWord(localDate(d, tz), today)} ${localTime(d, tz)}`,
    }));
  } catch {
    return [];
  }
}

/**
 * Any other change, which they already said yes to: the assistant plans and checks it and
 * it is saved; a clash or an open question goes back to the agent to explain.
 */
async function planChange(request: string, input: ActionInput): Promise<Outcome> {
  const { db, state, now } = input;
  const tz = state.profile.timezone;
  const romanUrdu = state.profile.language === 'ur-Latn';
  if (!request.trim()) return { ok: false, changed: false, problem: 'what to change was unclear' };
  const { plan } = await planWithLlm(
    request,
    promptContext({ tz, now, goals: state.goals, commitments: state.commitments, blocks: state.blocks, romanUrdu }),
    [],
    // The agent already wrote the request as one plain sentence, so quick thinking is enough.
    // Only the main model plans changes (the fallback misreads them), even if it means a wait.
    { reasoningEffort: 'low', maxTokens: 2000, waitBudgetMs: 25_000 },
  );
  const actions = await resolvePlan(plan, { state, tz, now }, db);
  const run = await db.insert<{ id: string }>('assistant_runs', {
    transcript: `(reminder call) ${request}`.slice(0, 2000),
    language: romanUrdu ? 'ur' : 'en',
    plan: { ...plan, meta: { source: 'call' } },
    checks: actions,
  });
  const changes = actions.filter((x) => (MUTATING_TYPES as string[]).includes(x.type));
  const open = actions.find((x) => x.status === 'needs_answer' || x.status === 'clash' || x.status === 'invalid');
  if (open) {
    const why = open.status === 'needs_answer'
      ? `it needs one more detail: ${open.question ?? open.summary}`
      : `${open.summary}: ${open.note ?? 'that time is taken'}`;
    return { ok: false, changed: false, problem: why };
  }
  if (changes.length === 0) {
    // nothing to change (a question about their week): the assistant's answer is the reply
    return { ok: true, changed: false, say: { text: plan.reply_text, voice: plan.reply_tts || plan.reply_text } };
  }
  await db.rpc('assistant_apply', { p_run: run.id, p_indexes: changes.map((x) => x.index) });
  return { ok: true, changed: true };
}

/** When the model can't be reached mid-call: say so kindly and hang up. */
export function fallbackLine(romanUrdu: boolean): { text: string; voice: string } {
  return romanUrdu
    ? { text: 'Maaf kijiye, abhi line theek nahi. Session app mein dekh lijiye. Allah Hafiz.', voice: 'معاف کیجیے، ابھی لائن ٹھیک نہیں۔ سیشن ایپ میں دیکھ لیجیے۔ اللہ حافظ۔' }
    : { text: "Sorry, the line isn't good right now. Please check the session in the app. Bye.", voice: "Sorry, the line isn't good right now. Please check the session in the app. Bye." };
}
