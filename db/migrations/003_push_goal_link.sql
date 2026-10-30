-- worker_claim_pushes() also returns goal_id, so a deadline push opens its goal. The
-- returned columns changed, so the old function is dropped first. (Fresh installs get
-- this from functions.sql.)

drop function if exists worker_claim_pushes();

-- Cron (every minute, only when FCM is configured): claim due pushes for users with a
-- registered device. Quiet hours skip everything except the start push; max 6 a day.
create or replace function worker_claim_pushes() returns table (
  job_id bigint, user_id text, kind text, block_id uuid, goal_id uuid, title text, starts_at timestamptz,
  ends_at timestamptz, lead_min int, language text, hide_titles boolean, tz text,
  goal_title text, days_left int, milestones_done int, milestones_total int,
  sessions_today int, tokens text[]
)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  return query
  with users as (
    select p.user_id, p.timezone as tz, p.quiet_start, p.quiet_end, p.briefing_at, p.language, p.hide_titles,
           (select array_agg(d.fcm_token) from devices d where d.user_id = p.user_id) as tokens,
           (select count(*) from notification_jobs j where j.user_id = p.user_id and j.sent_at > now() - interval '24 hours') as sent_24h
      from profiles p
     where p.notifications_enabled and exists (select 1 from devices d where d.user_id = p.user_id)
  ), candidates as (
    -- lead reminder
    select u.user_id, 'lead'::text as kind, b.id as block_id, b.id::text as ref,
           lower(b.period) - make_interval(mins => r.lead_min) as due_at
      from users u join calendar_blocks b on b.user_id = u.user_id and b.kind = 'session'
      join schedule_rules r on r.goal_id = b.goal_id
     where b.status in ('planned', 'snoozed') and r.lead_min > 0
       and lower(b.period) - make_interval(mins => r.lead_min) <= now()
       and lower(b.period) > now()
       and not in_quiet_hours(now(), now() + interval '1 minute', u.tz, u.quiet_start, u.quiet_end)
    union all
    -- start
    select u.user_id, 'start', b.id, b.id::text || ':' || extract(epoch from lower(b.period))::bigint::text, lower(b.period)
      from users u join calendar_blocks b on b.user_id = u.user_id and b.kind = 'session'
     where b.status in ('planned', 'snoozed')
       and lower(b.period) <= now() and lower(b.period) > now() - interval '10 minutes'
    union all
    -- missed follow-up, 30 minutes after start if still not started
    select u.user_id, 'missed', b.id, b.id::text, lower(b.period) + interval '30 minutes'
      from users u join calendar_blocks b on b.user_id = u.user_id and b.kind = 'session'
     where b.status in ('planned', 'snoozed')
       and lower(b.period) + interval '30 minutes' <= now()
       and lower(b.period) + interval '40 minutes' > now()
       and not in_quiet_hours(now(), now() + interval '1 minute', u.tz, u.quiet_start, u.quiet_end)
    union all
    -- deadline warnings 7/3/1 days before, at 09:00 local
    select u.user_id, 'deadline', null::uuid, g.id::text || ':' || (g.deadline - (now() at time zone u.tz)::date)::text,
           (((now() at time zone u.tz)::date + time '09:00') at time zone u.tz)
      from users u join goals g on g.user_id = u.user_id and g.status = 'active'
     where (g.deadline - (now() at time zone u.tz)::date) in (7, 3, 1)
       and (now() at time zone u.tz)::time >= time '09:00'
       and (now() at time zone u.tz)::time < time '09:30'
    union all
    -- morning briefing at the chosen time, only when something is on today
    select u.user_id, 'briefing', null::uuid, (now() at time zone u.tz)::date::text,
           (((now() at time zone u.tz)::date + u.briefing_at) at time zone u.tz)
      from users u
     where u.briefing_at is not null
       and (now() at time zone u.tz)::time >= u.briefing_at
       and (now() at time zone u.tz)::time < u.briefing_at + interval '30 minutes'
       and exists (select 1 from calendar_blocks b where b.user_id = u.user_id and b.kind = 'session'
                     and b.status in ('planned', 'snoozed') and lower(b.period) > now()
                     and (lower(b.period) at time zone u.tz)::date = (now() at time zone u.tz)::date)
  ), claimed as (
    -- A new candidate is claimed once. A failed send stays unsent and is retried by a
    -- later tick (at most 3 attempts, 2 minutes apart), so two ticks never send twice.
    insert into notification_jobs as j (user_id, block_id, kind, ref, due_at, attempts, claimed_at)
    select c.user_id, c.block_id, c.kind, c.ref, c.due_at, 1, now()
      from candidates c join users u on u.user_id = c.user_id
     where u.sent_24h < 6 or c.kind = 'start'
    on conflict on constraint notification_jobs_user_id_kind_ref_key do update
       set attempts = j.attempts + 1, claimed_at = now()
     where j.sent_at is null and j.attempts < 3 and j.claimed_at < now() - interval '2 minutes'
    returning j.id, j.user_id, j.kind, j.block_id, j.ref
  )
  select cl.id, cl.user_id, cl.kind, cl.block_id, coalesce(g.id, gd.id), b.title, lower(b.period), upper(b.period),
         r.lead_min, u.language, u.hide_titles, u.tz,
         coalesce(g.title, gd.title),
         case when gd.id is not null then (gd.deadline - (now() at time zone u.tz)::date) end,
         (select count(*)::int from milestones m where m.goal_id = coalesce(g.id, gd.id) and m.done_at is not null),
         (select count(*)::int from milestones m where m.goal_id = coalesce(g.id, gd.id)),
         (select count(*)::int from calendar_blocks bt where bt.user_id = cl.user_id and bt.kind = 'session'
            and bt.status in ('planned', 'snoozed')
            and (lower(bt.period) at time zone u.tz)::date = (now() at time zone u.tz)::date),
         u.tokens
    from claimed cl
    join users u on u.user_id = cl.user_id
    left join calendar_blocks b on b.id = cl.block_id
    left join schedule_rules r on r.goal_id = b.goal_id
    left join goals g on g.id = b.goal_id
    left join goals gd on cl.kind = 'deadline' and gd.id::text = split_part(cl.ref, ':', 1);
end $$;
revoke all on function worker_claim_pushes() from public;
grant execute on function worker_claim_pushes() to dispatcher;
