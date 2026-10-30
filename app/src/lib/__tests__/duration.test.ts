import { describe, expect, it } from '@jest/globals';
import { parseDuration } from '../duration';

describe('typed durations', () => {
  it.each([
    ['45', 45],
    ['45m', 45],
    ['90 min', 90],
    ['20 minutes', 20],
    ['1h', 60],
    ['1 hr', 60],
    ['2 hours', 120],
    ['1h 30m', 90],
    ['1h30', 90],
    ['1 hour 15', 75],
    ['1 hour and 45 minutes', 105],
    ['2.5h', 150],
    ['1,5 hours', 90],
    ['1:30', 90],
    ['0:45', 45],
    ['an hour', 60],
    ['half an hour', 30],
    ['half hour', 30],
    ['quarter hour', 15],
  ])('%s → %i min', (text, minutes) => {
    expect(parseDuration(text)).toBe(minutes);
  });

  it.each([
    ['1 ghanta', 60],
    ['2 ghante', 120],
    ['aadha ghanta', 30],
    ['dedh ghanta', 90],
    ['derh', 90],
    ['dhai ghante', 150],
    ['sawa ghanta', 75],
    ['sawa 2 ghante', 135],
    ['sarhe 3 ghante', 210],
    ['paune 2 ghante', 105],
    ['paun ghanta', 45],
    ['45 mint', 45],
  ])('Roman Urdu: %s → %i min', (text, minutes) => {
    expect(parseDuration(text)).toBe(minutes);
  });

  it.each(['', 'soon', 'h', '0', '0m', 'abc 5'])('"%s" is not a length', (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});
