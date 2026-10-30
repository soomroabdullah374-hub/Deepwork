import { describe, expect, it } from '@jest/globals';
import { inQuietHours, planReminders } from '../reminders';
import { makeState, NOW, TZ } from './fixtures';
import { localToUtc } from '../time';

describe('reminders', () => {
  it('plans lead, start and missed reminders for upcoming sessions', () => {
    const plan = planReminders(makeState(), NOW, 2);
    const forTonight = plan.filter((r) => r.blockId === 's_sun25').map((r) => r.kind);
    expect(forTonight).toEqual(['lead', 'start', 'missed']);
    const lead = plan.find((r) => r.id.startsWith('lead:s_sun25'))!;
    expect(lead.at.toISOString()).toBe(localToUtc('2026-10-25T17:50', TZ).toISOString());
    expect(lead.title).toBe('Cloud Data Engineering labs in 10 min');
    expect(lead.url).toBe('deepwork://focus/s_sun25');
  });

  it('adds a morning briefing on days with sessions, before the first one', () => {
    const plan = planReminders(makeState(), NOW, 2);
    const briefing = plan.find((r) => r.kind === 'briefing');
    expect(briefing?.at.toISOString()).toBe(localToUtc('2026-10-26T07:30', TZ).toISOString());
    expect(briefing?.body).toBe('1 session today.');
  });

  it('respects quiet hours across midnight, except for the start reminder', () => {
    expect(inQuietHours(localToUtc('2026-10-25T23:30', TZ), TZ, '23:00:00', '07:00:00')).toBe(true);
    expect(inQuietHours(localToUtc('2026-10-26T06:59', TZ), TZ, '23:00', '07:00')).toBe(true);
    expect(inQuietHours(localToUtc('2026-10-26T07:00', TZ), TZ, '23:00', '07:00')).toBe(false);
    const state = makeState();
    state.blocks.push({ ...state.blocks[1], id: 'late', starts_at: localToUtc('2026-10-25T23:15', TZ).toISOString(), ends_at: localToUtc('2026-10-26T00:15', TZ).toISOString() });
    const late = planReminders(state, NOW, 2).filter((r) => r.blockId === 'late').map((r) => r.kind);
    expect(late).toEqual(['start']);
  });

  it('hides titles, writes Roman Urdu, and stays off when notifications are off', () => {
    const state = makeState();
    state.profile.hide_titles = true;
    state.profile.language = 'ur-Latn';
    const start = planReminders(state, NOW, 1).find((r) => r.kind === 'start')!;
    expect(start.title).toBe('Focus session ka waqt');
    state.profile.notifications_enabled = false;
    expect(planReminders(state, NOW)).toEqual([]);
  });
});
