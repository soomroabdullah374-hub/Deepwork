// Shapes returned by the database functions (db/api.sql), as the Edge Functions use them.

export interface Rule {
  goal_id: string;
  weekdays: number[];
  start_time: string; // "20:00:00"
  duration_min: number;
  lead_min: number;
}

export interface Milestone {
  id: string;
  position: number;
  title: string;
  done_at: string | null;
}

export interface Goal {
  id: string;
  title: string;
  why: string | null;
  deadline: string; // "YYYY-MM-DD"
  status: 'active' | 'paused' | 'done';
  created_at: string;
  rule: Rule | null;
  milestones: Milestone[];
  sessions_done: number;
  minutes_done: number;
}

export interface Commitment {
  id: string;
  title: string;
  weekdays: number[];
  start_time: string;
  duration_min: number;
  one_off_date: string | null;
  starts_on: string | null;
  created_by: string;
  created_at: string;
}

export type BlockStatus = 'planned' | 'in_progress' | 'done' | 'skipped' | 'missed' | 'snoozed' | 'cancelled';

export interface Block {
  id: string;
  kind: 'session' | 'commitment';
  goal_id: string | null;
  commitment_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  slot_start: string | null;
  status: BlockStatus;
  minutes_done: number | null;
  note: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by: 'app' | 'generator' | 'assistant';
}

export interface Profile {
  user_id: string;
  display_name: string;
  timezone: string;
  language: 'en' | 'ur-Latn';
  quiet_start: string;
  quiet_end: string;
  briefing_at: string | null;
  theme: string;
  notifications_enabled: boolean;
  hide_titles: boolean;
  speak_replies: boolean;
  assistant_auto_apply: boolean;
  onboarded_at: string | null;
}

export interface AppState {
  now: string;
  profile: Profile;
  goals: Goal[];
  commitments: Commitment[];
  blocks: Block[];
  conflicts: unknown[];
  streak: { count: number; since: string | null };
}

/** Blocks that hold their time (cancelled and skipped ones free it). */
export function occupies(b: Pick<Block, 'status'>): boolean {
  return b.status !== 'cancelled' && b.status !== 'skipped';
}
