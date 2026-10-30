// Typed calls to the DeepWork API. Every call carries a fresh JWT; a 401 refreshes the
// token once and retries.

import { getToken } from './auth';
import { API_URL, ApiError, call, type CallOptions } from './http';
import type {
  AppState,
  ApplyResult,
  AssistantPlan,
  Block,
  CommitmentCheck,
  DraftPlan,
  FreeSlot,
  GenConflict,
  Health,
  Milestone,
  Profile,
  Transcript,
} from './types';

async function authed<T>(method: string, path: string, opts: Omit<CallOptions, 'token'> = {}): Promise<T> {
  try {
    return await call<T>(method, path, { ...opts, token: await getToken() });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && err.code !== 'signed_out') {
      return await call<T>(method, path, { ...opts, token: await getToken(true) });
    }
    throw err;
  }
}

const DAY = 86_400_000;

export interface RuleInput {
  weekdays: number[];
  start_time: string;
  duration_min: number;
  lead_min: number;
}

export interface CommitmentInput {
  title: string;
  weekdays: number[];
  start_time: string;
  duration_min: number;
  one_off_date?: string | null;
  starts_on?: string | null;
}

export const api = {
  health: () => call<Health>('GET', '/health'),

  state: (from = new Date(Date.now() - 7 * DAY), to = new Date(Date.now() + 15 * DAY)) =>
    authed<AppState>('GET', '/state', { query: { from: from.toISOString(), to: to.toISOString() } }),

  blocks: (from: Date, to: Date, goal?: string) =>
    authed<Block[]>('GET', '/blocks', { query: { from: from.toISOString(), to: to.toISOString(), goal } }),

  blockAction: (id: string, action: 'start' | 'finish' | 'skip' | 'cancel' | 'snooze' | 'move' | 'restore', body: Record<string, unknown> = {}) =>
    authed<Block>('POST', `/blocks/${id}/${action}`, { body }),

  freeSlotsFor: (id: string, days = 7) =>
    authed<{ minutes: number; slots: FreeSlot[] }>('GET', `/blocks/${id}/free-slots`, { query: { days } }),

  updateProfile: (patch: Partial<Profile> & { onboarded?: boolean }) =>
    authed<Profile>('PATCH', '/profile', { body: patch }),

  draftPlan: (input: { title: string; why?: string; deadline: string; rule?: Partial<RuleInput> }) =>
    authed<DraftPlan>('POST', '/goals/draft-plan', { body: input, timeoutMs: 45_000 }),

  createGoal: (input: { title: string; why?: string; deadline: string; milestones: { title: string }[]; rule: RuleInput }) =>
    authed<{ goal_id: string; conflicts: GenConflict[] }>('POST', '/goals', { body: input }),

  updateGoal: (id: string, patch: { title?: string; why?: string | null; deadline?: string; status?: string }) =>
    authed<{ goal_id: string; conflicts: GenConflict[] }>('PATCH', `/goals/${id}`, { body: patch }),

  deleteGoal: (id: string) => authed('DELETE', `/goals/${id}`),

  updateRule: (id: string, rule: RuleInput) =>
    authed<{ goal_id: string; conflicts: GenConflict[] }>('PUT', `/goals/${id}/rule`, { body: rule }),

  replaceMilestones: (id: string, milestones: { id?: string; title: string; done?: boolean }[]) =>
    authed<Milestone[]>('PUT', `/goals/${id}/milestones`, { body: { milestones } }),

  setMilestoneDone: (id: string, done: boolean) => authed('PATCH', `/milestones/${id}`, { body: { done } }),

  recentSessions: (goalId: string, limit = 10) =>
    authed<Block[]>('GET', `/goals/${goalId}/sessions`, { query: { limit } }),

  checkSlots: (input: CommitmentInput & { id?: string; ignore_goal?: string }) =>
    authed<CommitmentCheck>('POST', '/commitments/check', { body: input }),

  saveCommitment: (input: CommitmentInput, id?: string) =>
    id
      ? authed<{ commitment_id: string }>('PATCH', `/commitments/${id}`, { body: input })
      : authed<{ commitment_id: string }>('POST', '/commitments', { body: input }),

  deleteCommitment: (id: string) => authed('DELETE', `/commitments/${id}`),

  registerDevice: (token: string, platform: 'android' | 'ios') =>
    authed('POST', '/devices', { body: { token, platform } }),

  exportData: () => authed<Record<string, unknown>>('GET', '/export', { timeoutMs: 60_000 }),

  deleteAccount: () => authed('DELETE', '/account'),

  transcribe: async (fileUri: string, mime = 'audio/mp4') => {
    const form = new FormData();
    // React Native reads the file from its uri when the request is sent
    form.append('audio', { uri: fileUri, name: 'clip.m4a', type: mime } as unknown as Blob);
    return await authed<Transcript>('POST', '/assistant/transcribe', { form, timeoutMs: 90_000 });
  },

  plan: (text: string, meta: { confidence?: number | null; language?: string | null } = {}) =>
    authed<AssistantPlan>('POST', '/assistant/plan', { body: { text, ...meta }, timeoutMs: 90_000 }),

  answer: (runId: string, index: number, answer: string) =>
    authed<AssistantPlan>('POST', '/assistant/answer', { body: { run_id: runId, index, answer }, timeoutMs: 90_000 }),

  apply: (runId: string, indexes: number[]) =>
    authed<ApplyResult>('POST', '/assistant/apply', { body: { run_id: runId, indexes } }),

  undo: (runId: string) => authed('POST', '/assistant/undo', { body: { run_id: runId } }),

  /** URL and headers to stream the spoken reply straight into the audio player. */
  speechSource: async (text: string, language: string) => ({
    uri: `${API_URL}/assistant/speak?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(language)}`,
    headers: { Authorization: `Bearer ${await getToken()}` },
  }),
};
