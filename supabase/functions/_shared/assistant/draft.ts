// New goal › Plan: a milestone draft sized to the sessions that fit before the deadline.
// Uses the LLM when it is set up; otherwise (or if it fails) a sensible template, so
// creating a goal never depends on a third-party service.

import { chatJson } from './llm.ts';
import { DRAFT_JSON_SCHEMA, DraftSchema } from './schema.ts';
import { PLAN_DRAFT_PROMPT } from './prompt.ts';
import { addDays, daysBetween, weekdayOf } from '../time.ts';

export interface DraftInput {
  title: string;
  why?: string | null;
  start_date?: string | null; // YYYY-MM-DD, sessions begin on it (default: tomorrow)
  deadline: string; // YYYY-MM-DD
  weekdays: number[];
  duration_min: number;
  today: string; // user's local date
}

export interface DraftResult {
  milestones: { title: string; est_sessions: number | null }[];
  warning: string | null;
  capacity: { sessions: number; hours: number; weeks: number };
  source: 'ai' | 'template';
}

export function capacity(input: Pick<DraftInput, 'start_date' | 'deadline' | 'weekdays' | 'duration_min' | 'today'>) {
  let sessions = 0;
  const tomorrow = addDays(input.today, 1);
  const from = input.start_date && input.start_date > tomorrow ? input.start_date : tomorrow;
  const days = Math.max(0, daysBetween(from, input.deadline) + 1);
  for (let i = 0; i < days; i++) {
    if (input.weekdays.includes(weekdayOf(addDays(from, i)))) sessions++;
  }
  return {
    sessions,
    hours: Math.round((sessions * input.duration_min) / 6) / 10,
    weeks: Math.max(1, Math.ceil(days / 7)),
  };
}

function capacityWarning(sessions: number): string | null {
  if (sessions === 0) return 'No sessions fit before the deadline. Pick more days or a later date.';
  if (sessions < 3) {
    return `Only ${sessions} session${sessions === 1 ? '' : 's'} fit before the deadline. Consider more days or a later date.`;
  }
  return null;
}

export function templateMilestones(sessions: number): DraftResult['milestones'] {
  const steps = [
    'Define the scope and what done looks like',
    'Gather what you need and set up',
    'Build the first working version',
    'Review, test and improve',
    'Finish and share the result',
  ];
  const per = sessions > 0 ? Math.max(1, Math.round(sessions / steps.length)) : null;
  return steps.map((title) => ({ title, est_sessions: per }));
}

export async function draftPlan(input: DraftInput): Promise<DraftResult> {
  const cap = capacity(input);
  const fallback: DraftResult = {
    milestones: templateMilestones(cap.sessions),
    warning: capacityWarning(cap.sessions),
    capacity: cap,
    source: 'template',
  };
  try {
    const { data } = await chatJson(
      [
        { role: 'system', content: PLAN_DRAFT_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            goal: input.title,
            why: input.why || null,
            today: input.today,
            start_date: input.start_date ?? null,
            deadline: input.deadline,
            weeks_left: cap.weeks,
            sessions_per_week: input.weekdays.length,
            session_hours: input.duration_min / 60,
            total_sessions: cap.sessions,
            total_hours: cap.hours,
          }),
        },
      ],
      DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>,
      'deepwork_milestones',
    );
    const parsed = DraftSchema.safeParse(data);
    if (!parsed.success || parsed.data.milestones.length < 2) return fallback;
    return {
      milestones: parsed.data.milestones.map((m) => ({
        title: m.title.slice(0, 120),
        est_sessions: typeof m.est_sessions === 'number' && m.est_sessions > 0 ? Math.round(m.est_sessions) : null,
      })),
      warning: parsed.data.warning ?? capacityWarning(cap.sessions),
      capacity: cap,
      source: 'ai',
    };
  } catch (err) {
    console.warn('milestone draft fell back to the template:', (err as Error).message);
    return fallback;
  }
}
