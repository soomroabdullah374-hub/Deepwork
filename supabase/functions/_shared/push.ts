// What a server push says and how it is sent: pure, so it is unit-tested. The dispatcher
// does the sending (dispatcher/index.ts).

import { localTime } from './time.ts';

export interface PushJob {
  job_id: number;
  user_id: string;
  kind: 'lead' | 'start' | 'missed' | 'deadline' | 'briefing';
  block_id: string | null;
  goal_id: string | null;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  lead_min: number | null;
  language: string;
  hide_titles: boolean;
  tz: string;
  goal_title: string | null;
  days_left: number | null;
  milestones_done: number | null;
  milestones_total: number | null;
  sessions_today: number | null;
  tokens: string[] | null;
}

/** Notification text in the user's language; titles hidden when they asked for that. */
export function pushText(job: PushJob): { title: string; body: string } {
  const ur = job.language === 'ur-Latn';
  const name = job.hide_titles ? 'Focus session' : (job.title ?? 'Focus session');
  const range = job.starts_at && job.ends_at ? `${localTime(job.starts_at, job.tz)}–${localTime(job.ends_at, job.tz)}` : '';
  switch (job.kind) {
    case 'lead':
      return ur
        ? { title: `${name} ${job.lead_min} minute mein`, body: `${range} · Tayyar ho jaiye.` }
        : { title: `${name} in ${job.lead_min} min`, body: `${range} · Time to get ready.` };
    case 'start':
      return ur
        ? { title: `${name} ka waqt`, body: `${range}. Abhi shuru karein ya 10 minute baad.` }
        : { title: `Time for ${name}`, body: `${range}. Start now or snooze 10 minutes.` };
    case 'missed':
      return ur
        ? { title: `${name} reh gaya`, body: 'Koi khaali waqt chun kar ise move kar dein.' }
        : { title: `${name} was missed`, body: 'Pick a free slot to move it.' };
    case 'deadline': {
      const goal = job.hide_titles ? 'Your goal' : (job.goal_title ?? 'Your goal');
      const days = job.days_left ?? 0;
      const done = job.milestones_done ?? 0;
      const total = job.milestones_total ?? 0;
      return ur
        ? { title: `${goal}: ${days} din baqi`, body: `${total} mein se ${done} milestones mukammal.` }
        : { title: `${goal} is due in ${days} day${days === 1 ? '' : 's'}`, body: `${done} of ${total} milestones done.` };
    }
    case 'briefing': {
      const n = job.sessions_today ?? 0;
      return ur
        ? { title: 'Subah bakhair', body: `Aaj ${n} session${n === 1 ? '' : 's'} hain.` }
        : { title: 'Good morning', body: `${n} session${n === 1 ? '' : 's'} today.` };
    }
  }
}

/** Where tapping the notification goes; the same links as the phone's own reminders. */
export function pushLink(job: PushJob): string {
  if (job.block_id) return job.kind === 'missed' ? `deepwork://move/${job.block_id}` : `deepwork://focus/${job.block_id}`;
  if (job.kind === 'deadline' && job.goal_id) return `deepwork://goal/${job.goal_id}`;
  return 'deepwork://today';
}

// How long FCM may hold a push for a phone that is offline; a stale reminder is dropped.
const TTL_SECONDS: Record<PushJob['kind'], number> = { lead: 600, start: 900, missed: 1800, deadline: 10800, briefing: 7200 };

/**
 * A data-only FCM message. expo-notifications on the phone shows it exactly like a local
 * reminder: the "sessions" channel, Start / Snooze / Done on session reminders, and the
 * same tap data, so a tap opens the same screen.
 */
export function fcmMessage(token: string, job: PushJob) {
  const { title, body } = pushText(job);
  const ttl = job.kind === 'lead' ? Math.max(60, (job.lead_min ?? 10) * 60) : TTL_SECONDS[job.kind];
  const data: Record<string, string> = {
    title,
    message: body,
    body: JSON.stringify({ url: pushLink(job), kind: job.kind, block_id: job.block_id, goal_id: job.goal_id }),
    channelId: 'sessions',
    color: '#B8532F',
    tag: `${job.kind}:${job.block_id ?? job.goal_id ?? 'today'}`,
  };
  if (job.kind === 'lead' || job.kind === 'start') data.categoryId = 'session';
  return { message: { token, data, android: { priority: 'HIGH', ttl: `${ttl}s` } } };
}
