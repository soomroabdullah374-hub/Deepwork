// Turns the model's plan into concrete, checked actions. Nothing here trusts the model:
// every id is looked up in the user's own data, every time is converted from their zone,
// and every slot is checked against the calendar (and against the rest of the plan).
// The resolved actions are what the app shows and what assistant_apply() executes.

import type { ActionType, Plan, PlanAction } from './schema.ts';
import type { AppState, Block, Commitment, Goal } from '../state.ts';
import { occupies } from '../state.ts';
import type { Db } from '../neon.ts';
import {
  addDays,
  addMinutes,
  dayLabel,
  daysBetween,
  hhmm,
  localDate,
  localTime,
  localToUtc,
  minutesBetween,
  partOfDay,
  weekdayOf,
  WEEKDAYS_LONG,
  WEEKDAYS_SHORT,
} from '../time.ts';

export type ActionStatus = 'ok' | 'clash' | 'needs_answer' | 'info' | 'invalid';

export interface Clash {
  id: string | null;
  title: string;
  kind: string;
  starts_at: string;
  ends_at: string;
}

export interface ResolvedRule {
  weekdays: number[];
  start_time: string;
  duration_min: number;
  lead_min: number;
}

export interface ResolvedAction {
  index: number;
  type: ActionType;
  status: ActionStatus;
  /** Card title, e.g. "Add Gym". */
  summary: string;
  /** Card detail line, e.g. "Mon 26 Oct · 19:00–20:00". */
  when?: string;
  /** Status line under the card, e.g. "Free. Starts right after Cloud labs." */
  note?: string;
  /** Line on the saved screen, e.g. "Gym, added Sun 19:00". */
  done_label?: string;
  title?: string;
  goal_id?: string;
  session_id?: string;
  commitment_id?: string;
  occurrence_id?: string;
  starts_at?: string;
  ends_at?: string;
  from_starts_at?: string;
  from_ends_at?: string;
  local_date?: string;
  local_start_time?: string;
  duration_min?: number;
  repeat_weekdays?: number[];
  scope?: 'one' | 'series';
  rule?: ResolvedRule;
  clash?: Clash | null;
  question?: string;
  options?: string[];
}

export const MUTATING_TYPES: ActionType[] = [
  'add_commitment', 'add_session', 'move_session', 'cancel_session', 'delete_commitment', 'update_rule',
];

const HORIZON_DAYS = 14;
const MAX_DAYS_AHEAD = 120;

interface Slot {
  start: Date;
  end: Date;
}

interface Draft {
  action: ResolvedAction;
  /** Time this action holds once applied. */
  slots: Slot[];
  /** Blocks this action releases, for actions applied after it. */
  frees: string[];
  /** Blocks ignored for this action's own check (the session being moved, …). */
  ownIgnore: string[];
  /** Apply order, mirrored by assistant_apply(): frees, moves, rhythms, adds. */
  tier: number;
}

const TIER: Record<ActionType, number> = {
  cancel_session: 0,
  delete_commitment: 0,
  move_session: 1,
  update_rule: 2,
  add_session: 3,
  add_commitment: 3,
  clarify: 9,
  none: 9,
};

export interface ResolveInput {
  state: AppState;
  tz: string;
  now: Date;
}

class Resolver {
  readonly today: string;

  constructor(private readonly input: ResolveInput) {
    this.today = localDate(input.now, input.tz);
  }

  get tz() {
    return this.input.tz;
  }
  get now() {
    return this.input.now;
  }
  get state() {
    return this.input.state;
  }

  // ── lookups (ids from the model are only trusted if they exist in the user's data)
  goal(ref?: string): Goal | undefined {
    if (!ref) return undefined;
    const key = ref.trim().toLowerCase();
    return this.state.goals.find((g) => g.id === ref) ?? this.state.goals.find((g) => g.title.toLowerCase() === key);
  }

  session(ref?: string): Block | undefined {
    if (!ref) return undefined;
    return this.state.blocks.find((b) => b.id === ref && b.kind === 'session');
  }

  commitment(ref?: string): Commitment | undefined {
    if (!ref) return undefined;
    const key = ref.trim().toLowerCase();
    return (
      this.state.commitments.find((c) => c.id === ref) ??
      this.state.commitments.find((c) => c.title.toLowerCase() === key)
    );
  }

  // ── formatting in the user's zone
  range(start: Date | string, end: Date | string): string {
    return `${localTime(start, this.tz)}–${localTime(end, this.tz)}`;
  }

  whenOne(start: Date | string, end: Date | string): string {
    return `${dayLabel(localDate(start, this.tz))} · ${this.range(start, end)}`;
  }

  shortWhen(start: Date | string): string {
    return `${WEEKDAYS_SHORT[weekdayOf(localDate(start, this.tz))]} ${localTime(start, this.tz)}`;
  }

  slotAt(date: string, time: string, minutes: number): Slot {
    const start = localToUtc(`${date}T${time}`, this.tz);
    return { start, end: addMinutes(start, minutes) };
  }

  upcomingSessions(limit: number): Block[] {
    return this.state.blocks
      .filter((b) => b.kind === 'session' && occupies(b) && new Date(b.ends_at) > this.now && b.status !== 'done')
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .slice(0, limit);
  }

  sessionOption(b: Block): string {
    return `${shorten(b.title, 22)} · ${this.shortWhen(b.starts_at)}`.slice(0, 40);
  }

  // ── one draft per action
  draft(a: PlanAction, index: number): Draft {
    const base: ResolvedAction = {
      index,
      type: a.type,
      status: 'ok',
      summary: a.summary || defaultSummary(a),
    };
    const draft: Draft = { action: base, slots: [], frees: [], ownIgnore: [], tier: TIER[a.type] };
    const ask = (question: string, options: string[] = []): Draft => {
      draft.action = { ...base, status: 'needs_answer', question, options: options.slice(0, 3) };
      draft.slots = [];
      draft.frees = [];
      return draft;
    };
    const reject = (note: string): Draft => {
      draft.action = { ...base, status: 'invalid', note };
      draft.slots = [];
      draft.frees = [];
      return draft;
    };

    switch (a.type) {
      case 'clarify':
        return ask(a.question || 'Could you say a little more?', a.options ?? []);

      case 'none':
        draft.action = { ...base, status: 'info' };
        return draft;

      case 'add_commitment': {
        const title = a.title || stripVerb(a.summary);
        if (!title) return ask('What should I call it?');
        if (!a.start_local) return ask(`When should ${title} be?`);
        const date = a.start_local.slice(0, 10);
        const time = a.start_local.slice(11, 16);
        const minutes = a.duration_min ?? 60;
        const repeat = a.repeat_weekdays ?? [];
        if (daysBetween(this.today, date) > MAX_DAYS_AHEAD) return reject('That is more than 120 days away.');

        if (repeat.length > 0) {
          const from = date < this.today ? this.today : date;
          const occurrences: Slot[] = [];
          let first: Slot | undefined;
          for (let i = 0; i < 7 + HORIZON_DAYS && !first; i++) {
            const d = addDays(from, i);
            if (!repeat.includes(weekdayOf(d))) continue;
            const s = this.slotAt(d, time, minutes);
            if (s.end > this.now) first = s;
          }
          for (let i = 0; i < HORIZON_DAYS; i++) {
            const d = addDays(this.today, i);
            if (d < from || !repeat.includes(weekdayOf(d))) continue;
            const s = this.slotAt(d, time, minutes);
            if (s.end > this.now) occurrences.push(s);
          }
          const shown = first ?? this.slotAt(from, time, minutes);
          draft.slots = occurrences;
          draft.action = {
            ...base,
            title,
            local_date: from,
            local_start_time: time,
            duration_min: minutes,
            repeat_weekdays: repeat,
            starts_at: shown.start.toISOString(),
            ends_at: shown.end.toISOString(),
            when: `${daysText(repeat)} · ${this.range(shown.start, shown.end)}` +
              (first ? ` · from ${dayLabel(localDate(first.start, this.tz))}` : ''),
            done_label: `${title}, added ${this.shortWhen(shown.start)}`,
          };
          return draft;
        }

        const slot = this.slotAt(date, time, minutes);
        if (slot.end <= this.now) {
          return ask(`That time has already passed. When should ${title} be?`, [`Tomorrow ${time}`]);
        }
        draft.slots = [slot];
        draft.action = {
          ...base,
          title,
          local_date: date,
          local_start_time: time,
          duration_min: minutes,
          repeat_weekdays: [],
          starts_at: slot.start.toISOString(),
          ends_at: slot.end.toISOString(),
          when: this.whenOne(slot.start, slot.end),
          done_label: `${title}, added ${this.shortWhen(slot.start)}`,
        };
        return draft;
      }

      case 'add_session': {
        const goal = this.goal(a.goal_id);
        if (!goal) {
          return ask(
            'Which goal is this session for?',
            this.state.goals.filter((g) => g.status === 'active').map((g) => shorten(g.title, 40)),
          );
        }
        if (!a.start_local) return ask(`When should the ${shorten(goal.title, 40)} session be?`);
        const date = a.start_local.slice(0, 10);
        if (daysBetween(this.today, date) > MAX_DAYS_AHEAD) return reject('That is more than 120 days away.');
        const minutes = a.duration_min ?? goal.rule?.duration_min ?? 60;
        const slot = this.slotAt(date, a.start_local.slice(11, 16), minutes);
        if (slot.end <= this.now) {
          return ask('That time has already passed. When should the session be?', [
            `Tomorrow ${a.start_local.slice(11, 16)}`,
          ]);
        }
        draft.slots = [slot];
        draft.action = {
          ...base,
          title: goal.title,
          goal_id: goal.id,
          duration_min: minutes,
          starts_at: slot.start.toISOString(),
          ends_at: slot.end.toISOString(),
          when: this.whenOne(slot.start, slot.end),
          done_label: `${goal.title}, added ${this.shortWhen(slot.start)}`,
        };
        return draft;
      }

      case 'move_session': {
        const s = this.session(a.session_id);
        if (!s) return ask('Which session should I move?', this.upcomingSessions(3).map((b) => this.sessionOption(b)));
        if (s.status === 'done' || s.status === 'cancelled' || s.status === 'skipped') {
          return reject(`That session is already ${s.status === 'done' ? 'done' : s.status}.`);
        }
        if (!a.start_local) return ask(`When should I move ${shorten(s.title, 40)} to?`);
        const date = a.start_local.slice(0, 10);
        if (daysBetween(this.today, date) > MAX_DAYS_AHEAD) return reject('That is more than 120 days away.');
        const minutes = minutesBetween(s.starts_at, s.ends_at);
        const slot = this.slotAt(date, a.start_local.slice(11, 16), minutes);
        if (slot.end <= this.now) return ask('That time has already passed. When should it move to?');
        draft.slots = [slot];
        draft.frees = [s.id];
        draft.ownIgnore = [s.id];
        draft.action = {
          ...base,
          title: s.title,
          session_id: s.id,
          goal_id: s.goal_id ?? undefined,
          duration_min: minutes,
          starts_at: slot.start.toISOString(),
          ends_at: slot.end.toISOString(),
          from_starts_at: s.starts_at,
          from_ends_at: s.ends_at,
          when: `${this.dayTime(s.starts_at)} → ${this.dayTime(slot.start)}`,
          done_label: `${s.title}, moved ${this.shortWhen(slot.start)}`,
        };
        return draft;
      }

      case 'cancel_session': {
        const s = this.session(a.session_id);
        if (!s) {
          return ask('Which session should I cancel?', this.upcomingSessions(3).map((b) => this.sessionOption(b)));
        }
        if (s.status === 'done' || s.status === 'cancelled' || s.status === 'skipped') {
          return reject(`That session is already ${s.status}.`);
        }
        draft.frees = [s.id];
        draft.action = {
          ...base,
          title: s.title,
          session_id: s.id,
          goal_id: s.goal_id ?? undefined,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          when: this.whenOne(s.starts_at, s.ends_at),
          note: `Frees ${this.shortWhen(s.starts_at)}.`,
          done_label: `${s.title}, cancelled ${this.shortWhen(s.starts_at)}`,
        };
        return draft;
      }

      case 'delete_commitment': {
        const c = this.commitment(a.commitment_id);
        if (!c) {
          return ask('Which commitment should I remove?', this.state.commitments.map((x) => shorten(x.title, 40)));
        }
        const occurrences = this.state.blocks.filter((b) => b.commitment_id === c.id);
        const scope = c.one_off_date ? 'series' : (a.scope ?? (a.start_local ? 'one' : 'series'));
        if (scope === 'one') {
          if (!a.start_local) {
            const next = occurrences
              .filter((b) => occupies(b) && new Date(b.ends_at) > this.now)
              .sort((x, y) => x.starts_at.localeCompare(y.starts_at))
              .slice(0, 3)
              .map((b) => dayLabel(localDate(b.starts_at, this.tz)));
            return ask(`Which ${shorten(c.title, 60)} should I remove?`, next);
          }
          const date = a.start_local.slice(0, 10);
          const occ = occurrences.find(
            (b) => b.status !== 'cancelled' && localDate(b.slot_start ?? b.starts_at, this.tz) === date,
          );
          if (!occ) return reject(`There is no ${c.title} on ${dayLabel(date)}.`);
          draft.frees = [occ.id];
          draft.action = {
            ...base,
            title: c.title,
            commitment_id: c.id,
            occurrence_id: occ.id,
            scope: 'one',
            starts_at: occ.starts_at,
            ends_at: occ.ends_at,
            when: this.whenOne(occ.starts_at, occ.ends_at),
            note: 'Only this one. The rest stay.',
            done_label: `${c.title}, removed ${dayLabel(date)}`,
          };
          return draft;
        }
        draft.frees = occurrences.map((b) => b.id);
        draft.action = {
          ...base,
          title: c.title,
          commitment_id: c.id,
          scope: 'series',
          when: c.one_off_date
            ? `${dayLabel(c.one_off_date)} · ${hhmm(c.start_time)}`
            : `${daysText(c.weekdays)} · ${hhmm(c.start_time)}`,
          note: c.one_off_date ? 'Removes it.' : 'Removes it from every week.',
          done_label: `${c.title}, removed`,
        };
        return draft;
      }

      case 'update_rule': {
        const goal = this.goal(a.goal_id);
        if (!goal) {
          return ask("Which goal's rhythm should change?", this.state.goals.map((g) => shorten(g.title, 40)));
        }
        if (!goal.rule) return reject('That goal has no weekly rhythm yet.');
        const r = a.rule ?? {};
        if (r.weekdays === undefined && r.start_time === undefined && r.duration_min === undefined &&
            r.lead_min === undefined) {
          return ask('What should change: the days, the time or the length?');
        }
        const rule: ResolvedRule = {
          weekdays: r.weekdays ?? goal.rule.weekdays,
          start_time: r.start_time ?? hhmm(goal.rule.start_time),
          duration_min: r.duration_min ?? goal.rule.duration_min,
          lead_min: r.lead_min ?? goal.rule.lead_min,
        };
        // Mirror regenerate_goal(): untouched future generated sessions are replaced; days
        // that keep a moved or finished session of this goal get no new one.
        const regenerable = this.state.blocks.filter(
          (b) =>
            b.goal_id === goal.id && b.kind === 'session' && b.status === 'planned' &&
            b.created_by === 'generator' && b.slot_start !== null &&
            new Date(b.slot_start).getTime() === new Date(b.starts_at).getTime() &&
            new Date(b.starts_at) > this.now,
        );
        const regenIds = new Set(regenerable.map((b) => b.id));
        const keptDays = new Set(
          this.state.blocks
            .filter((b) => b.goal_id === goal.id && b.slot_start && !regenIds.has(b.id))
            .map((b) => localDate(b.slot_start as string, this.tz)),
        );
        if (goal.status === 'active') {
          for (let i = 0; i < HORIZON_DAYS; i++) {
            const d = addDays(this.today, i);
            if (d > goal.deadline) break;
            if (!rule.weekdays.includes(weekdayOf(d)) || keptDays.has(d)) continue;
            const s = this.slotAt(d, rule.start_time, rule.duration_min);
            if (s.start > this.now) draft.slots.push(s);
          }
        }
        draft.frees = [...regenIds];
        draft.ownIgnore = [...regenIds];
        const lead = rule.lead_min > 0 ? ` · reminder ${rule.lead_min} min before` : '';
        draft.action = {
          ...base,
          title: goal.title,
          goal_id: goal.id,
          rule,
          when: `${daysText(rule.weekdays)} · ${rule.start_time} · ${rule.duration_min} min${lead}`,
          done_label: `${goal.title}, new rhythm`,
        };
        return draft;
      }
    }
  }

  dayTime(start: Date | string): string {
    const d = localDate(start, this.tz);
    return `${WEEKDAYS_SHORT[weekdayOf(d)]} ${Number(d.slice(8, 10))} · ${localTime(start, this.tz)}`;
  }

  /** What else holds time on that local day, after this plan (for the "free" notes). */
  dayItems(date: string, ignore: Set<string>, drafts: Draft[], self: Draft): { title: string; start: Date; end: Date }[] {
    const items = this.state.blocks
      .filter((b) => occupies(b) && !ignore.has(b.id) && localDate(b.starts_at, this.tz) === date)
      .map((b) => ({ title: b.title, start: new Date(b.starts_at), end: new Date(b.ends_at) }));
    for (const d of drafts) {
      if (d === self || d.action.status !== 'ok') continue;
      for (const s of d.slots) {
        if (localDate(s.start, this.tz) === date) items.push({ title: d.action.title ?? d.action.summary, start: s.start, end: s.end });
      }
    }
    return items;
  }

  freeNote(slot: Slot, items: { title: string; start: Date; end: Date }[]): string {
    const before = items.find((i) => Math.abs(i.end.getTime() - slot.start.getTime()) < 60_000);
    if (before) return `Free. Starts right after ${before.title}.`;
    const after = items.find((i) => Math.abs(i.start.getTime() - slot.end.getTime()) < 60_000);
    if (after) return `Free. Ends right before ${after.title}.`;
    const date = localDate(slot.start, this.tz);
    const part = partOfDay(localTime(slot.start, this.tz));
    const samePart = items.some((i) => partOfDay(localTime(i.start, this.tz)) === part);
    if (!samePart) return `${WEEKDAYS_LONG[weekdayOf(date)]} ${part} is free.`;
    return 'Free.';
  }
}

/** Resolve and check a plan. `db` runs check_slots() as the user. */
export async function resolvePlan(plan: Plan, input: ResolveInput, db: Pick<Db, 'rpc'>): Promise<ResolvedAction[]> {
  const r = new Resolver(input);
  const drafts = plan.actions.map((a, i) => r.draft(a, i));

  const isEarlier = (x: Draft, y: Draft) => x.tier < y.tier || (x.tier === y.tier && x.action.index < y.action.index);
  const ignoreFor = (d: Draft): Set<string> => {
    const ids = new Set(d.ownIgnore);
    for (const other of drafts) {
      if (other !== d && other.action.status === 'ok' && isEarlier(other, d)) other.frees.forEach((id) => ids.add(id));
    }
    return ids;
  };

  // Walk the plan in apply order, so each action is checked against the calendar as it
  // will be at that moment: earlier cancels and moves have freed their time, earlier
  // adds hold theirs. One check_slots() call per action, run as the user.
  const ordered = [...drafts].sort((x, y) => x.tier - y.tier || x.action.index - y.action.index);
  const taken: { slot: Slot; draft: Draft }[] = [];
  for (const d of ordered) {
    if (d.action.status !== 'ok' || d.slots.length === 0) continue;

    const rows = await db.rpc<{ index: number; clash: Clash | null }[]>('check_slots', {
      p_slots: d.slots.map((s) => ({ starts_at: s.start.toISOString(), ends_at: s.end.toISOString() })),
      p_ignore_ids: [...ignoreFor(d)],
    });
    const hit = rows.find((row) => row.clash)?.clash;
    if (hit) {
      d.action = {
        ...d.action,
        status: 'clash',
        clash: hit,
        note: `That time is taken. ${r.shortWhen(hit.starts_at)}–${localTime(hit.ends_at, r.tz)} is ${hit.title}.`,
      };
      continue;
    }

    const overlap = d.slots
      .map((s) => taken.find((t) => t.slot.start < s.end && s.start < t.slot.end))
      .find(Boolean);
    if (overlap) {
      const other = overlap.draft.action;
      d.action = {
        ...d.action,
        status: 'clash',
        clash: {
          id: null,
          title: other.title ?? other.summary,
          kind: other.type === 'add_commitment' ? 'commitment' : 'session',
          starts_at: overlap.slot.start.toISOString(),
          ends_at: overlap.slot.end.toISOString(),
        },
        note: `Overlaps "${other.summary}" in this same request.`,
      };
      continue;
    }
    d.slots.forEach((slot) => taken.push({ slot, draft: d }));
  }

  // Notes for the actions that passed.
  for (const d of drafts) {
    const a = d.action;
    if (a.status !== 'ok' || a.note) continue;
    if (a.type === 'update_rule') {
      const n = d.slots.length;
      a.note = n === 0 ? 'No new sessions in the next 2 weeks.' : `${n} session${n === 1 ? '' : 's'} in the next 2 weeks, all free.`;
    } else if (d.slots.length > 1) {
      a.note = 'No clashes in the next 2 weeks.';
    } else if (d.slots.length === 1) {
      const slot = d.slots[0];
      a.note = r.freeNote(slot, r.dayItems(localDate(slot.start, r.tz), ignoreFor(d), drafts, d));
    }
  }

  return drafts.sort((x, y) => x.action.index - y.action.index).map((d) => d.action);
}

export function isAutoApplicable(actions: ResolvedAction[]): boolean {
  const changes = actions.filter((a) => MUTATING_TYPES.includes(a.type));
  return changes.length > 0 && actions.every((a) => a.status === 'ok' || a.status === 'info');
}

// ── small helpers
function daysText(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 7) return 'Every day';
  if (set.join(',') === '1,2,3,4,5') return 'Weekdays';
  if (set.join(',') === '0,6') return 'Weekends';
  return `Every ${set.map((d) => WEEKDAYS_SHORT[d]).join(', ')}`;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function stripVerb(summary: string): string {
  return summary.replace(/^(add|put|block|schedule|book)\s+/i, '').trim();
}

function defaultSummary(a: PlanAction): string {
  switch (a.type) {
    case 'add_commitment':
      return `Add ${a.title ?? 'commitment'}`;
    case 'add_session':
      return 'Add a session';
    case 'move_session':
      return 'Move a session';
    case 'cancel_session':
      return 'Cancel a session';
    case 'delete_commitment':
      return 'Remove a commitment';
    case 'update_rule':
      return 'Change the weekly rhythm';
    case 'clarify':
      return 'Question';
    default:
      return 'Reply';
  }
}
