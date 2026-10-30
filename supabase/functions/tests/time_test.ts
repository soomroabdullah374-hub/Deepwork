import { assertEquals } from 'jsr:@std/assert@1';
import {
  addDays, dayLabel, daysBetween, hhmm, localDate, localStamp, localTime, localToUtc, longDayLabel, partOfDay, weekdayOf,
} from '../_shared/time.ts';

Deno.test('Karachi wall time converts to UTC and back', () => {
  const utc = localToUtc('2026-10-26T19:00', 'Asia/Karachi');
  assertEquals(utc.toISOString(), '2026-10-26T14:00:00.000Z');
  assertEquals(localStamp(utc, 'Asia/Karachi'), '2026-10-26T19:00');
});

Deno.test('times near midnight land on the right local date', () => {
  const utc = new Date('2026-10-25T19:30:00Z'); // 00:30 on the 26th in Karachi
  assertEquals(localDate(utc, 'Asia/Karachi'), '2026-10-26');
  assertEquals(localTime(utc, 'Asia/Karachi'), '00:30');
  assertEquals(localDate(utc, 'UTC'), '2026-10-25');
});

Deno.test('DST zones use the offset of that day', () => {
  // New York: EST (UTC-5) before 8 Mar 2026, EDT (UTC-4) after
  assertEquals(localToUtc('2026-03-07T09:00', 'America/New_York').toISOString(), '2026-03-07T14:00:00.000Z');
  assertEquals(localToUtc('2026-03-09T09:00', 'America/New_York').toISOString(), '2026-03-09T13:00:00.000Z');
  // London: BST until 25 Oct 2026
  assertEquals(localToUtc('2026-10-24T09:00', 'Europe/London').toISOString(), '2026-10-24T08:00:00.000Z');
  assertEquals(localToUtc('2026-10-26T09:00', 'Europe/London').toISOString(), '2026-10-26T09:00:00.000Z');
});

Deno.test('calendar helpers', () => {
  assertEquals(weekdayOf('2026-10-25'), 0);
  assertEquals(weekdayOf('2026-10-31'), 6);
  assertEquals(addDays('2026-10-25', 7), '2026-11-01');
  assertEquals(addDays('2026-03-01', -1), '2026-02-28');
  assertEquals(daysBetween('2026-10-25', '2026-12-15'), 51);
  assertEquals(dayLabel('2026-10-26'), 'Mon 26 Oct');
  assertEquals(longDayLabel('2026-10-25'), 'Sunday 25 October 2026');
  assertEquals(hhmm('20:00:00'), '20:00');
  assertEquals(hhmm('7:05'), '07:05');
  assertEquals(partOfDay('19:00'), 'evening');
  assertEquals(partOfDay('09:00'), 'morning');
});
