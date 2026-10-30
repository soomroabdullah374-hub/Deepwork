import { addDays, dayLabel, localDate, localTime, localToUtc, mondayOf, relativeIn, zoneLabel } from '../time';

describe('time zones', () => {
  it('converts local wall time to UTC and back', () => {
    const d = localToUtc('2026-10-26T19:00', 'Asia/Karachi');
    expect(d.toISOString()).toBe('2026-10-26T14:00:00.000Z');
    expect(localDate(d, 'Asia/Karachi')).toBe('2026-10-26');
    expect(localTime(d, 'Asia/Karachi')).toBe('19:00');
  });

  it('handles DST in other zones', () => {
    expect(localToUtc('2026-03-09T09:00', 'America/New_York').toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('formats days and relative times', () => {
    expect(dayLabel('2026-10-26')).toBe('Mon 26 Oct');
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    const now = new Date('2026-10-25T12:15:00Z');
    expect(relativeIn(now, new Date('2026-10-25T13:00:00Z'))).toBe('in 45 min');
    expect(relativeIn(now, new Date('2026-10-25T14:20:00Z'))).toBe('in 2 h 5 min');
    expect(zoneLabel('Asia/Karachi')).toContain('UTC+5');
  });
});
