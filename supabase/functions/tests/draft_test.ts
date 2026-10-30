import { assertEquals } from 'jsr:@std/assert@1';
import { capacity } from '../_shared/assistant/draft.ts';

// Fri 30 Oct 2026; Mon/Wed/Fri at an hour each
const base = { today: '2026-10-30', weekdays: [1, 3, 5], duration_min: 60 };

Deno.test('capacity counts sessions from tomorrow to the deadline', () => {
  // 2 Nov – 13 Nov: Mon, Wed, Fri twice
  assertEquals(capacity({ ...base, deadline: '2026-11-13' }), { sessions: 6, hours: 6, weeks: 2 });
});

Deno.test('capacity counts from a later start date', () => {
  // 9 Nov – 13 Nov: one Mon, Wed, Fri
  assertEquals(capacity({ ...base, start_date: '2026-11-09', deadline: '2026-11-13' }), { sessions: 3, hours: 3, weeks: 1 });
  // a start in the past or today counts from tomorrow, as without one
  assertEquals(capacity({ ...base, start_date: '2026-10-01', deadline: '2026-11-13' }).sessions, 6);
  assertEquals(capacity({ ...base, start_date: '2026-11-14', deadline: '2026-11-13' }).sessions, 0);
});
