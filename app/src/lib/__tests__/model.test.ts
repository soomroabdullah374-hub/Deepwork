import { describe, expect, it } from '@jest/globals';
import {
  cadenceLetters, dayRibbon, goalProgress, greeting, missedSessions, nextSession, nudgeTime,
  overlapCount, sessionsBetween, shortLabel, todaySummary, weekStats,
} from '../model';
import { block, makeState, NOW, TZ } from './fixtures';

describe('Today', () => {
  it('greets by local time of day', () => {
    expect(greeting(NOW, TZ, 'Abdullah Soomro')).toBe('Good evening, Abdullah.');
    expect(greeting(new Date('2026-10-25T03:00:00Z'), TZ, '')).toBe('Good morning.');
  });

  it('summarises what is left and what to reschedule', () => {
    expect(todaySummary(makeState(), NOW)).toBe('One session left today, and one to reschedule.');
  });

  it('picks the next open session and the missed one', () => {
    const state = makeState();
    expect(nextSession(state, NOW)?.id).toBe('s_sun25');
    expect(missedSessions(state, NOW).map((b) => b.id)).toEqual(['s_sat24']);
  });

  it('places blocks on the 06–24 ribbon', () => {
    const r = dayRibbon(makeState().blocks, NOW, TZ);
    expect(r.nowLabel).toBe('17:15');
    expect(r.now).toBeCloseTo((17.25 - 6) / 18, 5);
    expect(r.items.map((i) => i.block.id)).toEqual(['done1', 's_sun25']);
  });
});

describe('Goals', () => {
  it('measures progress by milestones and shows the cadence', () => {
    const g = makeState().goals[0];
    expect(goalProgress(g)).toBeCloseTo(0.4);
    expect(cadenceLetters(g.rule!.weekdays)).toBe('M · W · S');
    expect(nudgeTime(g.rule!)).toBe('19:50');
    expect(nudgeTime({ start_time: '00:05', lead_min: 10 })).toBe('23:55');
  });

  it('counts the sessions a rhythm gives before a deadline', () => {
    expect(sessionsBetween([1, 3, 6], '2026-10-25', '2026-12-15')).toBe(22);
  });

  it('finds overlaps but ignores cancelled blocks', () => {
    const state = makeState();
    expect(overlapCount(state.blocks)).toBe(0);
    const clash = block('x', 'session', 'X', '2026-10-26T15:00', '2026-10-26T16:00');
    expect(overlapCount([...state.blocks, clash])).toBe(1);
    expect(overlapCount([...state.blocks, { ...clash, status: 'cancelled' }])).toBe(0);
  });
});

describe('Insights', () => {
  it('adds up the week Monday to Sunday', () => {
    const state = makeState();
    const w = weekStats(state, state.blocks, '2026-10-19', NOW);
    expect(w.end).toBe('2026-10-25');
    expect(w.shownUp).toBe(3);
    expect(w.due).toBe(4);
    expect(w.rate).toBeCloseTo(0.75);
    expect(w.doneHours).toBeCloseTo((85 + 90 + 60) / 60);
    expect(w.days.map((d) => d.letter).join('')).toBe('MTWTFSS');
    expect(w.days[6].isToday).toBe(true);
    expect(w.days[5].missedMin).toBe(90);
  });
});

describe('labels', () => {
  it('shortens titles for small blocks', () => {
    expect(shortLabel('Finish AI Agent portfolio project')).toBe('AI');
    expect(shortLabel('Write the freelance case study')).toBe('Case');
    expect(shortLabel('Cloud Data Engineering labs')).toBe('Labs');
    expect(shortLabel('Training class')).toBe('Class');
    expect(shortLabel('Gym')).toBe('Gym');
  });
});
