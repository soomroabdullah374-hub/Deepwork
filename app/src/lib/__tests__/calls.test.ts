import { describe, expect, it } from '@jest/globals';
import { callsFor } from '../calls';
import type { AppState } from '../types';
import { makeState, NOW } from './fixtures';

// NOW is Sunday 25 Oct 17:15 in Karachi; the Cloud lab is at 18:00 today, the AI session
// at 20:00 tomorrow.
function withCalls(cloud: number, ai = 0, over: Partial<AppState> = {}): AppState {
  const state = makeState(over);
  return {
    ...state,
    goals: state.goals.map((g) => ({ ...g, rule: g.rule && { ...g.rule, call_lead_min: g.id === 'g_cloud' ? cloud : ai } })),
  };
}

describe('reminder calls', () => {
  it('rings the set minutes before each upcoming session of a goal with calls on', () => {
    const calls = callsFor(withCalls(10), NOW, new Set());
    expect(calls).toEqual([
      { id: 's_sun25', at: new Date('2026-10-25T12:50:00Z').getTime(), title: 'DeepWork', body: 'Cloud Data Engineering labs · 18:00, in 10 min' },
    ]);
  });

  it('says it in Roman Urdu and keeps titles private when asked', () => {
    const urdu = withCalls(10, 15);
    urdu.profile = { ...urdu.profile, language: 'ur-Latn', hide_titles: true };
    expect(callsFor(urdu, NOW, new Set()).map((c) => c.body)).toEqual([
      'Aap ka focus session · 18:00 baje, 10 minute mein',
      'Aap ka focus session · 20:00 baje, 15 minute mein',
    ]);
  });

  it('no call once the reminder was answered, for a time already gone, or with calls off', () => {
    expect(callsFor(withCalls(10), NOW, new Set(['s_sun25']))).toEqual([]);
    expect(callsFor(withCalls(60), NOW, new Set())).toEqual([]); // 17:00 has passed
    expect(callsFor(withCalls(0), NOW, new Set())).toEqual([]);
    const off = withCalls(10);
    off.profile = { ...off.profile, notifications_enabled: false };
    expect(callsFor(off, NOW, new Set())).toEqual([]);
  });

  it('only sessions still to come: not done, missed or started ones, nor paused goals', () => {
    const state = withCalls(10, 10);
    state.blocks = state.blocks.map((b) => (b.id === 's_mon26' ? { ...b, status: 'in_progress' } : b));
    expect(callsFor(state, NOW, new Set()).map((c) => c.id)).toEqual(['s_sun25']);
    state.goals = state.goals.map((g) => (g.id === 'g_cloud' ? { ...g, status: 'paused' } : g));
    expect(callsFor(state, NOW, new Set())).toEqual([]);
  });
});
