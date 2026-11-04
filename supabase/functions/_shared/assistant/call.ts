// The reminder call. When a session's reminder went unanswered, the phone rings and this
// agent talks it through like a friend on the phone: Roman Urdu (or English), one or two
// short sentences a turn, and at most one action per turn, carried out right here: start,
// a little later, another time, skip, already done, or any other change (the agent asks
// first; on their yes the assistant plans, checks and saves it). The app keeps the
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

export const CALL_ACTIONS = ['none', 'start', 'snooze', 'move', 'skip', 'done', 'change'] as const;
export type CallActionType = (typeof CALL_ACTIONS)[number];

export interface CallLine {
  who: 'agent' | 'user';
  text: string;
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const CALL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['heard', 'reply', 'reply_voice', 'action', 'end_call'],
  properties: {
    heard: { type: 'string' },
    reply: { type: 'string' },
    reply_voice: { type: 'string' },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'minutes', 'date', 'time', 'request'],
      properties: {
        type: { type: 'string', enum: [...CALL_ACTIONS] },
        minutes: nullable({ type: 'integer' }),
        date: nullable({ type: 'string' }),
        time: nullable({ type: 'string' }),
        request: nullable({ type: 'string' }),
      },
    },
    end_call: { type: 'boolean' },
  },
} as const;

const text = (max: number) => z.string().catch('').transform((s) => s.trim().slice(0, max));

export const CallReplySchema = z.object({
  heard: text(300).default(''),
  reply: text(400),
  reply_voice: text(400).default(''),
  action: z
    .object({
      type: z.enum(CALL_ACTIONS).catch('none'),
      minutes: z.number().int().nullish().catch(null),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().catch(null),
      time: z.string().regex(/^\d{1,2}:\d{2}/).transform((t) => t.padStart(5, '0').slice(0, 5)).nullish().catch(null),
      request: z.string().nullish().catch(null),
    })
    .catch({ type: 'none', minutes: null, date: null, time: null, request: null }),
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
}

const dayWord = (date: string, today: string) => {
  const d = daysBetween(today, date);
  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : `${WEEKDAYS_LONG[weekdayOf(date)]} ${date}`;
};

/** Everything the agent needs to know, in the person's local time. */
export function callContext(state: AppState, block: Block, now: Date, freeStarts: string[]): CallContext {
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
  };
}

/**
 * Which free starts to offer: the soonest few, plus the one closest to the session's own
 * time tomorrow ("kal isi waqt").
 */
export function pickFreeTimes(starts: string[], block: Pick<Block, 'starts_at'>, soon = 3): string[] {
  const at = (s: string) => new Date(s).getTime();
  const sorted = starts.filter((s) => !Number.isNaN(at(s))).sort((x, y) => at(x) - at(y));
  const picked = sorted.slice(0, soon);
  const tomorrow = at(block.starts_at) + 24 * 3_600_000;
  let closest: string | null = null;
  for (const s of sorted) if (closest === null || Math.abs(at(s) - tomorrow) < Math.abs(at(closest) - tomorrow)) closest = s;
  if (closest && !picked.includes(closest) && Math.abs(at(closest) - tomorrow) <= 3 * 3_600_000) picked.push(closest);
  return picked;
}

export function callSystemPrompt(c: CallContext): string {
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
- "reply" is what you say. ${voice}
- "heard" is what they just said, written ${c.romanUrdu ? 'in Roman Urdu' : 'in English'} (fix obvious transcription slips); empty on the first turn.

The session: "${c.session.title}", ${c.session.when}; it ${until}. Status: ${c.session.status}.
${c.session.why ? `Why it matters to them (use it only briefly, to encourage): ${c.session.why}\n` : ''}Now: ${c.now}.
Also on their calendar: ${c.around.length ? c.around.join('; ') : 'nothing else today or tomorrow'}.
Free times for this session: ${c.freeTimes.length ? c.freeTimes.join(', ') : 'none found soon'}.

Put exactly one action in "action":
- start: they start the session now (or at its time).
- snooze: a little later; "minutes" from 5 to 120.
- move: another time; "date" (YYYY-MM-DD) and "time" (HH:MM, 24-hour). Prefer the free times.
- skip: not today.
- done: they already did it.
- change: they said yes to another change to their schedule (add or move something else, change their weekly rhythm): write the whole request in plain English in "request", e.g. "Add gym tomorrow at 7 pm for 1 hour". It is checked and saved at once.
- none: just talking, or you need to ask something.

Rules:
- The action you return is carried out at once. So never ask "theek hai?" or "confirm?" about it: say it is done, e.g. "Theek hai, session 9:06 par kar diya."
- snooze and move move the session itself (not just its reminder).
- Two things can't be at the same time: never suggest a time that is taken on their calendar. If they ask for a specific time, return move with it anyway: it is checked, and if it is taken you will be told what is free near it.
- A time with no day means the day you were talking about. "Aath baje" while talking about the evening means 20:00; if morning or evening is unclear, ask ("subah ya shaam?").
- Act only on a clear decision. "Haan", "theek hai", "kar do" right after you suggested something is a clear yes to that suggestion.
- Any other change they ask for: first ask once if you should do it (action none), e.g. "Kal shaam 7 baje gym, ek ghante ke liye, add kar doon?". When they say yes, return "change" and say it is done. If it can't be done you will be told why.
- If they are vague ("dekhta hoon", "pata nahi"), suggest one concrete option (start now, or one free time) and ask.
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
    onTheLine({ reasoningEffort: 'low', maxTokens: 1500 }),
  );
  const parsed = CallReplySchema.safeParse(out.data);
  if (!parsed.success || !parsed.data.reply) throw new HttpError(502, 'ai_failed', 'The call agent could not answer.');
  return parsed.data;
}

// ───────────────────────── carrying out what they decided

export interface Outcome {
  ok: boolean;
  /** Something in their schedule changed (the app refreshes). */
  changed: boolean;
  /** Why it could not be done, for the agent to explain. */
  problem?: string;
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
          const near = await freeNear(input, at);
          const problem = problemOf(err, tz, today);
          return { ok: false, changed: false, problem: near.length ? `${problem}; free near then: ${near.join(', ')}` : problem };
        }
        return done();
      }
      case 'skip':
        await blockAction('skip', { reason: 'Skipped on the reminder call' });
        return done();
      case 'done':
        await blockAction('finish');
        return done();
      case 'change':
        return await planChange(a.request ?? '', input);
      default:
        return done(false);
    }
  } catch (err) {
    return { ok: false, changed: false, problem: problemOf(err, tz, today) };
  }
}

/** The free start closest before and closest after a time, for a session this long. */
async function freeNear({ db, state, block, now }: ActionInput, at: Date): Promise<string[]> {
  const tz = state.profile.timezone;
  const hour = 3_600_000;
  try {
    const slots = await db.rpc<{ starts_at: string }[]>('free_slots', {
      p_duration_min: Math.round(minutesBetween(block.starts_at, block.ends_at)),
      p_from: new Date(Math.max(now.getTime(), at.getTime() - 4 * hour)).toISOString(),
      p_to: new Date(at.getTime() + 5 * hour).toISOString(),
      p_limit: 60,
      p_ignore: block.id,
      p_step_min: 15,
    });
    if (!Array.isArray(slots)) return [];
    const times = slots.map((s) => new Date(s.starts_at)).filter((d) => !Number.isNaN(d.getTime()));
    const before = times.filter((d) => d < at).sort((x, y) => y.getTime() - x.getTime())[0];
    const after = times.filter((d) => d > at).sort((x, y) => x.getTime() - y.getTime())[0];
    const today = localDate(now, tz);
    return [before, after].filter((d): d is Date => !!d).map((d) => `${dayWord(localDate(d, tz), today)} ${localTime(d, tz)}`);
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
    onTheLine(),
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
