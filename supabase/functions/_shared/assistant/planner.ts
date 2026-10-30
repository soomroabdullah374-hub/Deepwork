// Builds the planner's context from the user's data and asks the LLM for a plan:
// strict JSON schema, temperature 0, Zod validation, one retry with the validation
// error, then a polite "say it again" if the second answer is still unusable.

import { type ChatMessage, chatJson } from './llm.ts';
import { buildSystemPrompt, type PromptContext } from './prompt.ts';
import { describeIssues, type Plan, PLAN_JSON_SCHEMA, PlanSchema } from './schema.ts';
import type { Block, Commitment, Goal } from '../state.ts';
import { addDays, hhmm, localDate, localStamp, localTime, longDayLabel, weekdayOf, WEEKDAYS_LONG, WEEKDAYS_SHORT } from '../time.ts';

export const LOW_CONFIDENCE = 0.6;

const URDU_SCRIPT = /[؀-ۿ]/;
const ROMAN_URDU_HINTS =
  /\b(kal|aaj|parson|subah|shaam|sham|raat|dopahar|baje|kar do|kardo|rakh do|daal do|hata do|badal do|shift kar|har|itwaar|peer|mangal|budh|jumeraat|juma|ghanta|mere|mera|wala|wale|ko|ka|ki|hai)\b/i;

export function guessReplyLanguage(text: string): 'en' | 'ur-Latn' {
  return URDU_SCRIPT.test(text) || ROMAN_URDU_HINTS.test(text) ? 'ur-Latn' : 'en';
}

/** The fixed reply when speech or the model's answer can't be used. */
export function sayAgainPlan(language: 'en' | 'ur-Latn' | 'ur'): Plan {
  if (language === 'en') {
    const text = "Sorry, I didn't catch that. Could you say it again?";
    return {
      reply_language: 'en',
      reply_text: text,
      reply_tts: text,
      actions: [{ type: 'clarify', summary: 'Say it again', question: text, options: [] } as Plan['actions'][number]],
    };
  }
  return {
    reply_language: 'ur-Latn',
    reply_text: 'Maaf kijiye, main samajh nahi saka. Dobara keh dein?',
    reply_tts: 'معاف کیجیے، میں سمجھ نہیں سکا۔ دوبارہ کہہ دیں؟',
    actions: [
      {
        type: 'clarify',
        summary: 'Dobara kahein',
        question: 'Maaf kijiye, main samajh nahi saka. Dobara keh dein?',
        options: [],
      } as Plan['actions'][number],
    ],
  };
}

export interface ContextInput {
  tz: string;
  now: Date;
  goals: Goal[];
  commitments: Commitment[];
  blocks: Block[];
  romanUrdu?: boolean;
}

/** The CONTEXT block of the system prompt, in the user's local time. */
export function promptContext(input: ContextInput): PromptContext {
  const { tz, now } = input;
  const today = localDate(now, tz);
  const lastDay = addDays(today, 14);
  const weekAgo = addDays(today, -7);

  const goals = input.goals
    .filter((g) => g.status !== 'done')
    .map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      deadline: g.deadline,
      rule: g.rule
        ? {
          weekdays: g.rule.weekdays,
          start_time: hhmm(g.rule.start_time),
          duration_min: g.rule.duration_min,
          lead_min: g.rule.lead_min,
        }
        : null,
    }));

  // Sessions from today on, plus last week's missed ones (so "move Saturday's missed
  // session" can move the real one).
  const sessions = input.blocks
    .filter((b) => b.kind === 'session' && b.status !== 'cancelled')
    .filter((b) => {
      const d = localDate(b.starts_at, tz);
      return (d >= today && d < lastDay) || (b.status === 'missed' && d >= weekAgo);
    })
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .map((b) => ({
      id: b.id,
      goal_id: b.goal_id,
      title: b.title,
      day: WEEKDAYS_SHORT[weekdayOf(localDate(b.starts_at, tz))],
      start: localStamp(b.starts_at, tz),
      end: localTime(b.ends_at, tz),
      status: b.status,
    }));

  const commitments = input.commitments
    .filter((c) => !c.one_off_date || c.one_off_date >= today)
    .map((c) => ({
      id: c.id,
      title: c.title,
      ...(c.one_off_date ? { date: c.one_off_date } : { weekdays: c.weekdays }),
      start_time: hhmm(c.start_time),
      duration_min: c.duration_min,
    }));

  return {
    timezone: tz,
    nowLocal: `${longDayLabel(today)}, ${localTime(now, tz)}`,
    weekday: WEEKDAYS_LONG[weekdayOf(today)],
    goals,
    sessions,
    commitments,
    calendar: calendarLine(today),
    romanUrdu: input.romanUrdu,
  };
}

export function calendarLine(today: string, days = 15): string {
  const labels = ['today', 'tomorrow', 'day after tomorrow'];
  return Array.from({ length: days }, (_, i) => {
    const d = addDays(today, i);
    return `${WEEKDAYS_SHORT[weekdayOf(d)]} ${d}${labels[i] ? ` (${labels[i]})` : ''}`;
  }).join(', ');
}

export interface PlanResult {
  plan: Plan;
  model: string | null;
  attempts: number;
  /** The model's raw JSON, kept in assistant_runs for the eval set. */
  raw: unknown;
}

/**
 * Ask the model for a plan. `history` carries an earlier exchange when the user answers
 * one of the assistant's questions.
 */
export async function planWithLlm(
  text: string,
  ctx: PromptContext,
  history: ChatMessage[] = [],
): Promise<PlanResult> {
  let messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    ...history,
    { role: 'user', content: text },
  ];
  let raw: unknown = null;
  let model: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Provider errors (no key, rejected key, outage) go to the app as they are.
    const out = await chatJson(messages, PLAN_JSON_SCHEMA as unknown as Record<string, unknown>, 'deepwork_plan');
    raw = out.data;
    model = out.model;
    const parsed = PlanSchema.safeParse(out.data);
    if (parsed.success) return { plan: parsed.data, model, attempts: attempt, raw };
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(out.data) },
      {
        role: 'user',
        content: `That JSON does not match the schema (${describeIssues(parsed.error)}). Return the corrected JSON object only.`,
      },
    ];
  }
  return { plan: sayAgainPlan(guessReplyLanguage(text)), model, attempts: 2, raw };
}
