// The plan the LLM returns: a strict JSON schema for constrained decoding, and a Zod
// schema that validates it and normalises small slips (nulls, seconds on a time, a
// Sunday written as 7, an over-long label) instead of throwing the whole plan away.

import { z } from 'npm:zod@3.25.76';

export const ACTION_TYPES = [
  'add_commitment',
  'add_session',
  'move_session',
  'cancel_session',
  'delete_commitment',
  'update_rule',
  'clarify',
  'none',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

// Strict mode needs every property listed in `required` and no unsupported keywords,
// so optional fields are nullable here and the limits live in Zod below.
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply_language', 'reply_text', 'reply_tts', 'actions'],
  properties: {
    reply_language: { type: 'string', enum: ['en', 'ur', 'ur-Latn'] },
    reply_text: { type: 'string' },
    reply_tts: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'type', 'summary', 'title', 'goal_id', 'session_id', 'commitment_id', 'start_local',
          'duration_min', 'repeat_weekdays', 'scope', 'rule', 'question', 'options', 'expect_free',
        ],
        properties: {
          type: { type: 'string', enum: [...ACTION_TYPES] },
          summary: { type: 'string' },
          title: nullable({ type: 'string' }),
          goal_id: nullable({ type: 'string' }),
          session_id: nullable({ type: 'string' }),
          commitment_id: nullable({ type: 'string' }),
          start_local: nullable({ type: 'string' }),
          duration_min: nullable({ type: 'integer' }),
          repeat_weekdays: nullable({ type: 'array', items: { type: 'integer' } }),
          scope: nullable({ type: 'string', enum: ['one', 'series'] }),
          rule: nullable({
            type: 'object',
            additionalProperties: false,
            required: ['weekdays', 'start_time', 'duration_min', 'lead_min'],
            properties: {
              weekdays: nullable({ type: 'array', items: { type: 'integer' } }),
              start_time: nullable({ type: 'string' }),
              duration_min: nullable({ type: 'integer' }),
              lead_min: nullable({ type: 'integer' }),
            },
          }),
          question: nullable({ type: 'string' }),
          options: nullable({ type: 'array', items: { type: 'string' } }),
          expect_free: nullable({ type: 'boolean' }),
        },
      },
    },
  },
} as const;

/** null, "" and undefined all mean "not given". */
const opt = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null || v === '' ? undefined : v), schema.optional());

const clip = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

// 7 is Sunday in ISO numbering; the app uses 0.
const weekday = z.number().int().min(0).max(7).transform((d) => d % 7);
const weekdays = z.array(weekday).max(14).transform((days) => [...new Set(days)].sort((a, b) => a - b));

// "2026-10-26T19:00", also accepting seconds or a space instead of the T.
const localStamp = z
  .string()
  .trim()
  .transform((s) => s.replace(' ', 'T'))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/, 'start_local must be YYYY-MM-DDTHH:mm'))
  .transform((s) => s.slice(0, 16));

const hhmm = z
  .string()
  .trim()
  .regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'start_time must be HH:mm')
  .transform((s) => s.padStart(5, '0').slice(0, 5));

// Out-of-range lengths are clamped (the card shows the result); zero means "not given".
const minutes = (lo: number, hi: number) =>
  z.number().transform((n) => (n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : undefined));

export const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  summary: clip(120).default(''),
  title: opt(clip(80)),
  goal_id: opt(z.string().trim().min(1)),
  session_id: opt(z.string().trim().min(1)),
  commitment_id: opt(z.string().trim().min(1)),
  start_local: opt(localStamp),
  duration_min: opt(minutes(15, 480)),
  repeat_weekdays: opt(weekdays),
  scope: opt(z.enum(['one', 'series'])),
  rule: opt(
    z.object({
      weekdays: opt(weekdays.transform((d) => (d.length ? d : undefined))),
      start_time: opt(hhmm),
      duration_min: opt(minutes(15, 240)),
      lead_min: opt(minutes(0, 120)),
    }),
  ),
  question: opt(clip(140)),
  options: opt(z.array(clip(40)).transform((o) => o.filter(Boolean).slice(0, 3))),
  expect_free: opt(z.boolean()),
});
export type PlanAction = z.infer<typeof ActionSchema>;

export const PlanSchema = z.object({
  reply_language: z.enum(['en', 'ur', 'ur-Latn']),
  reply_text: clip(280),
  reply_tts: clip(280),
  actions: z.array(ActionSchema).max(8),
});
export type Plan = z.infer<typeof PlanSchema>;

export const DraftSchema = z.object({
  milestones: z
    .array(z.object({ title: clip(120).pipe(z.string().min(1)), est_sessions: z.number().nullish() }))
    .min(1)
    .transform((m) => m.slice(0, 8)),
  warning: z.string().nullish().transform((w) => (w ? w.trim().slice(0, 280) || null : null)),
});

export const DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['milestones', 'warning'],
  properties: {
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'est_sessions'],
        properties: { title: { type: 'string' }, est_sessions: { type: 'integer' } },
      },
    },
    warning: nullable({ type: 'string' }),
  },
} as const;

/** One readable line per Zod issue, fed back to the model on the retry. */
export function describeIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
