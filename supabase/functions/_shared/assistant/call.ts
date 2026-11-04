// The reminder call. When a session's reminder went unanswered, the phone rings and this
// agent talks it through like a friend on the phone: Roman Urdu (or English), one or two
// short sentences a turn, and at most one action per turn, carried out right here: start,
// a little later, another time, skip, already done, or any other change (planned by the
// assistant and confirmed with a yes first). The app keeps the conversation and sends it
// back every turn, so the server stores nothing about the call itself.

import { z } from 'npm:zod@3.25.76';
import { HttpError } from '../http.ts';
import type { Db } from '../neon.ts';
import type { AppState, Block } from '../state.ts';
import { addDays, daysBetween, localDate, localTime, localToUtc, minutesBetween, weekdayOf, WEEKDAYS_LONG } from '../time.ts';
import { type ChatMessage, chatJson } from './llm.ts';
import { planWithLlm, promptContext } from './planner.ts';
import { MUTATING_TYPES, resolvePlan } from './resolve.ts';

export const CALL_ACTIONS = ['none', 'start', 'snooze', 'move', 'skip', 'done', 'change', 'confirm', 'cancel'] as const;
export type CallActionType = (typeof CALL_ACTIONS)[number];

export interface CallLine {
  who: 'agent' | 'user';
  text: string;
}

/** A planned change waiting for their yes. */
export interface Pending {
  run_id: string;
  summary: string;
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
  pending: string | null;
}

const dayWord = (date: string, today: string) => {
  const d = daysBetween(today, date);
  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : `${WEEKDAYS_LONG[weekdayOf(date)]} ${date}`;
};

/** Everything the agent needs to know, in the person's local time. */
export function callContext(
  state: AppState,
  block: Block,
  now: Date,
  freeStarts: string[],
  pending: Pending | null,
): CallContext {
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
    pending: pending?.summary ?? null,
  };
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
${c.pending ? `Waiting for their yes or no: ${c.pending}\n` : ''}
Put exactly one action in "action":
- start: they start the session now (or at its time).
- snooze: a little later; "minutes" from 5 to 120.
- move: another time; "date" (YYYY-MM-DD) and "time" (HH:MM, 24-hour). Prefer the free times.
- skip: not today.
- done: they already did it.
- change: any other change to their schedule (add or move something else, change their weekly rhythm): write the whole request in plain English in "request", e.g. "Add gym tomorrow at 7 pm for 1 hour". It is checked and they confirm it next.
- confirm or cancel: their yes or no to the change that is waiting.
- none: just talking, or you need to ask something.

Rules:
- Act only on a clear decision. "Haan", "theek hai", "kar do" right after you suggested something is a clear yes to that suggestion.
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

export async function callReply(c: CallContext, history: CallLine[], said: string | null, note?: string): Promise<CallReply> {
  const messages: ChatMessage[] = [
    { role: 'system', content: callSystemPrompt(c) },
    { role: 'user', content: callUserMessage(history, said) },
  ];
  if (note) messages.push({ role: 'user', content: note });
  const out = await chatJson(messages, CALL_JSON_SCHEMA as unknown as Record<string, unknown>, 'deepwork_call', { reasoningEffort: 'low' });
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
  /** Said instead of the agent's line (a planned change to confirm, or its question). */
  say?: { text: string; voice: string };
  pending: Pending | null;
}

interface ClashDetail {
  title?: string;
  starts_at?: string;
  ends_at?: string;
}

function problemOf(err: unknown, tz: string): string {
  if (err instanceof HttpError) {
    const w = (err.extra?.with ?? null) as ClashDetail | null;
    if (err.code === 'clash' && w?.title) {
      return `that time is taken by ${w.title}${w.starts_at && w.ends_at ? ` (${localTime(w.starts_at, tz)}–${localTime(w.ends_at, tz)})` : ''}`;
    }
    return err.message;
  }
  return (err as Error).message ?? 'it could not be done';
}

export interface ActionInput {
  db: Pick<Db, 'rpc' | 'select' | 'insert'>;
  state: AppState;
  block: Block;
  now: Date;
  pending: Pending | null;
}

const LIVE = new Set<Block['status']>(['planned', 'snoozed', 'missed']);

export async function runCallAction(a: CallAction, input: ActionInput): Promise<Outcome> {
  const { db, state, block } = input;
  const tz = state.profile.timezone;
  const blockAction = (action: string, p: Record<string, unknown> = {}) =>
    db.rpc('block_action', { p_id: block.id, p_action: action, p });
  const done = (changed = true): Outcome => ({ ok: true, changed, pending: input.pending });
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
        if (!a.date || !a.time) return { ok: false, changed: false, problem: 'the day or time was missing', pending: input.pending };
        await blockAction('move', { starts_at: localToUtc(`${a.date}T${a.time}`, tz).toISOString() });
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
      case 'confirm': {
        if (!input.pending) return { ok: false, changed: false, problem: 'there is no change waiting', pending: null };
        const rows = await db.select<{ checks: { index: number; type: string; status: string }[]; applied_at: string | null }>(
          'assistant_runs',
          `id=eq.${input.pending.run_id}&select=checks,applied_at`,
        );
        const run = rows[0];
        if (!run || run.applied_at) return { ok: true, changed: false, pending: null };
        const indexes = run.checks.filter((c) => c.status === 'ok' && (MUTATING_TYPES as string[]).includes(c.type)).map((c) => c.index);
        await db.rpc('assistant_apply', { p_run: input.pending.run_id, p_indexes: indexes });
        return { ok: true, changed: true, pending: null };
      }
      case 'cancel':
        return { ok: true, changed: false, pending: null };
      default:
        return done(false);
    }
  } catch (err) {
    return { ok: false, changed: false, problem: problemOf(err, tz), pending: input.pending };
  }
}

/** Any other change: the assistant plans it; a ready plan waits for their yes. */
async function planChange(request: string, input: ActionInput): Promise<Outcome> {
  const { db, state, now } = input;
  const tz = state.profile.timezone;
  const romanUrdu = state.profile.language === 'ur-Latn';
  if (!request.trim()) return { ok: false, changed: false, problem: 'what to change was unclear', pending: input.pending };
  const { plan } = await planWithLlm(
    request,
    promptContext({ tz, now, goals: state.goals, commitments: state.commitments, blocks: state.blocks, romanUrdu }),
  );
  const actions = await resolvePlan(plan, { state, tz, now }, db);
  const run = await db.insert<{ id: string }>('assistant_runs', {
    transcript: `(reminder call) ${request}`.slice(0, 2000),
    language: romanUrdu ? 'ur' : 'en',
    plan: { ...plan, meta: { source: 'call' } },
    checks: actions,
  });
  const changes = actions.filter((x) => (MUTATING_TYPES as string[]).includes(x.type));
  const open = actions.find((x) => x.status === 'needs_answer' || x.status === 'clash');
  const reply = plan.reply_text;
  const voice = plan.reply_tts || plan.reply_text;
  if (open) {
    const q = open.status === 'needs_answer' ? open.question ?? '' : open.note ?? '';
    return { ok: true, changed: false, say: { text: `${reply} ${q}`.trim(), voice: `${voice} ${q}`.trim() }, pending: null };
  }
  if (changes.length === 0) return { ok: true, changed: false, say: { text: reply, voice }, pending: null };
  const ask = romanUrdu ? { text: 'Kar doon?', voice: 'کر دوں؟' } : { text: 'Shall I do that?', voice: 'Shall I do that?' };
  return {
    ok: true,
    changed: false,
    say: { text: `${reply} ${ask.text}`, voice: `${voice} ${ask.voice}` },
    pending: { run_id: run.id, summary: changes.map((x) => x.summary).join('; ') },
  };
}

/** When the model can't be reached mid-call: say so kindly and hang up. */
export function fallbackLine(romanUrdu: boolean): { text: string; voice: string } {
  return romanUrdu
    ? { text: 'Maaf kijiye, abhi line theek nahi. Session app mein dekh lijiye. Allah Hafiz.', voice: 'معاف کیجیے، ابھی لائن ٹھیک نہیں۔ سیشن ایپ میں دیکھ لیجیے۔ اللہ حافظ۔' }
    : { text: "Sorry, the line isn't good right now. Please check the session in the app. Bye.", voice: "Sorry, the line isn't good right now. Please check the session in the app. Bye." };
}
