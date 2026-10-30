// Shapes the API returns (see supabase/functions and db/api.sql).

export interface Rule {
  goal_id: string;
  weekdays: number[]; // 0 = Sunday
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

export type GoalStatus = 'active' | 'paused' | 'done';

export interface Goal {
  id: string;
  title: string;
  why: string | null;
  start_date: string | null; // YYYY-MM-DD, sessions begin on it (null: right away)
  deadline: string; // YYYY-MM-DD
  status: GoalStatus;
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
  theme: 'light' | 'dark' | 'auto';
  notifications_enabled: boolean;
  hide_titles: boolean;
  speak_replies: boolean;
  assistant_auto_apply: boolean;
  onboarded_at: string | null;
}

export interface GenConflict {
  kind: 'session' | 'commitment';
  ref_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  clash_id: string | null;
  clash_title: string | null;
  clash_starts_at: string | null;
  clash_ends_at: string | null;
}

export interface AppState {
  now: string;
  profile: Profile;
  goals: Goal[];
  commitments: Commitment[];
  blocks: Block[];
  conflicts: GenConflict[];
  streak: { count: number; since: string | null };
}

export interface Clash {
  id: string | null;
  title: string;
  kind: string;
  starts_at: string;
  ends_at: string;
}

export type ActionType =
  | 'add_commitment' | 'add_session' | 'move_session' | 'cancel_session'
  | 'delete_commitment' | 'update_rule' | 'clarify' | 'none';

export interface AssistantAction {
  index: number;
  type: ActionType;
  status: 'ok' | 'clash' | 'needs_answer' | 'info' | 'invalid';
  summary: string;
  when?: string;
  note?: string;
  done_label?: string;
  title?: string;
  starts_at?: string;
  ends_at?: string;
  clash?: Clash | null;
  question?: string;
  options?: string[];
}

export interface AssistantPlan {
  run_id: string;
  transcript: string;
  reply_language: 'en' | 'ur' | 'ur-Latn';
  reply_text: string;
  reply_tts: string;
  actions: AssistantAction[];
  ready: number;
  auto_applied?: boolean;
  applied?: ApplyResult;
}

export interface ApplyResult {
  applied: { index: number; type: ActionType; id: string | null }[];
  undo_until: string;
}

export interface Transcript {
  text: string;
  language: string | null;
  confidence: number | null;
}

export interface FreeSlot {
  starts_at: string;
  ends_at: string;
  reason: string;
  taken?: { title: string };
}

export interface DraftPlan {
  milestones: { title: string; est_sessions: number | null }[];
  warning: string | null;
  capacity: { sessions: number; hours: number; weeks: number };
  source: 'ai' | 'template';
}

export interface CommitmentCheck {
  ok: boolean;
  occurrences: number;
  clashes: { starts_at: string; ends_at: string; with: Clash; message: string }[];
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthResult {
  session: string;
  jwt: string;
  user: AuthUser;
}

export interface Health {
  ok: boolean;
  version: string;
  llm: { configured: boolean; provider: string; model: string };
  speech_to_text: { configured: boolean; provider: string };
  text_to_speech: { configured: boolean; provider: string };
}
