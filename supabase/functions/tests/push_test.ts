import { assertEquals } from 'jsr:@std/assert@1';
import { fcmMessage, type PushJob, pushLink, pushText } from '../_shared/push.ts';

const job = (over: Partial<PushJob>): PushJob => ({
  job_id: 1,
  user_id: 'u1',
  kind: 'lead',
  block_id: 'b1',
  goal_id: 'g1',
  title: 'AI Agent portfolio',
  starts_at: '2026-10-26T15:00:00Z',
  ends_at: '2026-10-26T16:30:00Z',
  lead_min: 10,
  language: 'en',
  hide_titles: false,
  tz: 'Asia/Karachi',
  goal_title: 'Finish AI Agent portfolio project',
  days_left: 3,
  milestones_done: 2,
  milestones_total: 5,
  sessions_today: 2,
  tokens: ['t'],
  ...over,
});

Deno.test('a lead push is data-only, on the sessions channel, with the session buttons', () => {
  const { message } = fcmMessage('device-token', job({}));
  assertEquals(message.token, 'device-token');
  assertEquals('notification' in message, false);
  assertEquals(message.android, { priority: 'HIGH', ttl: '600s' });
  assertEquals(message.data.title, 'AI Agent portfolio in 10 min');
  assertEquals(message.data.message, '20:00–21:30 · Time to get ready.');
  assertEquals(message.data.channelId, 'sessions');
  assertEquals(message.data.categoryId, 'session');
  assertEquals(JSON.parse(message.data.body), { url: 'deepwork://focus/b1', kind: 'lead', block_id: 'b1', goal_id: 'g1' });
});

Deno.test('Roman Urdu reminders read naturally', () => {
  assertEquals(pushText(job({ language: 'ur-Latn' })), {
    title: 'AI Agent portfolio 10 minute mein',
    body: '20:00–21:30 · Tayyar ho jaiye.',
  });
  assertEquals(pushText(job({ kind: 'start', language: 'ur-Latn' })).title, 'AI Agent portfolio ka waqt');
  assertEquals(pushText(job({ kind: 'deadline', block_id: null, language: 'ur-Latn' })), {
    title: 'Finish AI Agent portfolio project: 3 din baqi',
    body: '5 mein se 2 milestones mukammal.',
  });
  assertEquals(pushText(job({ kind: 'briefing', block_id: null, language: 'ur-Latn' })).body, 'Aaj 2 sessions hain.');
});

Deno.test('taps open the same screens as local reminders', () => {
  assertEquals(pushLink(job({ kind: 'start' })), 'deepwork://focus/b1');
  assertEquals(pushLink(job({ kind: 'missed' })), 'deepwork://move/b1');
  assertEquals(pushLink(job({ kind: 'deadline', block_id: null })), 'deepwork://goal/g1');
  assertEquals(pushLink(job({ kind: 'briefing', block_id: null, goal_id: null })), 'deepwork://today');
});

Deno.test('stale pushes expire, and only session reminders carry buttons', () => {
  const missed = fcmMessage('t', job({ kind: 'missed' })).message;
  assertEquals(missed.android.ttl, '1800s');
  assertEquals(missed.data.categoryId, undefined);
  assertEquals(fcmMessage('t', job({ lead_min: 30 })).message.android.ttl, '1800s');
  assertEquals(fcmMessage('t', job({ kind: 'briefing', block_id: null, goal_id: null })).message.data.tag, 'briefing:today');
});

Deno.test('hidden titles stay hidden in pushes', () => {
  assertEquals(pushText(job({ hide_titles: true })).title, 'Focus session in 10 min');
  assertEquals(pushText(job({ kind: 'deadline', hide_titles: true })).title, 'Your goal is due in 3 days');
});
