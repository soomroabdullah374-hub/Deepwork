import { describe, expect, it } from '@jest/globals';
import { parseClock } from '../clockTime';

describe('typed times', () => {
  it.each([
    ['20:30', '20:30'],
    ['8:30', '08:30'],
    ['8.30', '08:30'],
    ['830', '08:30'],
    ['2030', '20:30'],
    ['8', '08:00'],
    ['20', '20:00'],
    ['0:15', '00:15'],
    ['8 pm', '20:00'],
    ['8pm', '20:00'],
    ['8:30 p.m.', '20:30'],
    ['8:30PM', '20:30'],
    ['7 am', '07:00'],
    ['12 am', '00:00'],
    ['12:30 am', '00:30'],
    ['12 pm', '12:00'],
    ["8 o'clock", '08:00'],
    ['at 9', '09:00'],
    ['2030 hrs', '20:30'],
    ['noon', '12:00'],
    ['midnight', '00:00'],
    ['20:00 pm', '20:00'],
  ])('%s → %s', (text, time) => {
    expect(parseClock(text)).toBe(time);
  });

  it.each([
    ['raat 8 baje', '20:00'],
    ['8 baje raat', '20:00'],
    ['raat 12 baje', '00:00'],
    ['raat 2 baje', '02:00'],
    ['subah 7', '07:00'],
    ['subah 7:30 baje', '07:30'],
    ['shaam 6 baje', '18:00'],
    ['dopahar 2 baje', '14:00'],
    ['dopahar 12', '12:00'],
    ['saade 8', '08:30'],
    ['saade 8 shaam', '20:30'],
    ['sawa 9 baje raat', '21:15'],
    ['paune 10 subah', '09:45'],
    ['dedh baje', '01:30'],
    ['dhai baje dopahar', '14:30'],
    ['aadhi raat', '00:00'],
  ])('Roman Urdu: %s → %s', (text, time) => {
    expect(parseClock(text)).toBe(time);
  });

  it.each(['', 'soon', '25', '8:75', '13 am', 'abc 5', '12345'])('"%s" is not a time', (text) => {
    expect(parseClock(text)).toBeNull();
  });
});
