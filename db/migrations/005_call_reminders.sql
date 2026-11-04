-- Reminder calls: a rhythm can ring the phone like a call this many minutes before a
-- session whose reminder went unanswered (0: no call). app_state now also returns each
-- goal's start date. (Fresh installs get this from schema.sql and api.sql.)

alter table schedule_rules add column if not exists call_lead_min int not null default 0;
alter table schedule_rules drop constraint if exists schedule_rules_call_lead_min_check;
alter table schedule_rules add constraint schedule_rules_call_lead_min_check check (call_lead_min between 0 and 120);


create or replace function app_state(p_from timestamptz, p_to timestamptz,
                                     p_display_name text default '', p_timezone text default null)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid       text := require_user();
  v_profile   jsonb;
  v_conflicts jsonb;
  v_streak    record;
begin
  v_profile := ensure_profile(p_display_name, p_timezone);
  perform mark_my_missed();
  select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_conflicts from generate_blocks(14) c;
  select * into v_streak from my_streak();

  return jsonb_build_object(
    'now', now(),
    'profile', v_profile,
    'goals', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', g.id, 'title', g.title, 'why', g.why, 'start_date', g.start_date, 'deadline', g.deadline,
               'status', g.status, 'created_at', g.created_at,
               'rule', (select to_jsonb(r) - 'user_id' from schedule_rules r where r.goal_id = g.id),
               'milestones', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'id', m.id, 'position', m.position, 'title', m.title, 'done_at', m.done_at)
                               order by m.position), '[]')
                              from milestones m where m.goal_id = g.id),
               'sessions_done', (select count(*) from calendar_blocks b where b.goal_id = g.id and b.status = 'done'),
               'minutes_done', (select coalesce(sum(b.minutes_done), 0) from calendar_blocks b where b.goal_id = g.id and b.status = 'done'))
             order by g.created_at), '[]')
        from goals g where g.user_id = v_uid),
    'commitments', (
      select coalesce(jsonb_agg(to_jsonb(c) - 'user_id' order by c.created_at), '[]')
        from commitments c where c.user_id = v_uid),
    'blocks', (
      select coalesce(jsonb_agg(block_json(b) order by lower(b.period)), '[]')
        from calendar_blocks b
       where b.user_id = v_uid and b.period && tstzrange(p_from, p_to, '[)')),
    'conflicts', v_conflicts,
    'streak', jsonb_build_object('count', coalesce(v_streak.streak, 0), 'since', v_streak.since));
end $$;

create or replace function create_goal(p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid   text := require_user();
  v_goal  uuid;
  v_start date := nullif(p ->> 'start_date', '')::date;
  i       int := 0;
  m       jsonb;
begin
  if (p ->> 'deadline')::date <= (now() at time zone my_tz())::date then
    raise exception 'The deadline must be tomorrow or later.' using errcode = '22023';
  end if;
  if v_start > (p ->> 'deadline')::date then
    raise exception 'The start date must be on or before the deadline.' using errcode = '22023';
  end if;
  insert into goals (user_id, title, why, start_date, deadline)
  values (v_uid, btrim(p ->> 'title'), nullif(btrim(coalesce(p ->> 'why', '')), ''), v_start, (p ->> 'deadline')::date)
  returning id into v_goal;

  for m in select value from jsonb_array_elements(coalesce(p -> 'milestones', '[]')) loop
    continue when btrim(coalesce(m ->> 'title', '')) = '';
    insert into milestones (user_id, goal_id, position, title) values (v_uid, v_goal, i, btrim(m ->> 'title'));
    i := i + 1;
  end loop;

  insert into schedule_rules (goal_id, user_id, weekdays, start_time, duration_min, lead_min, call_lead_min)
  values (v_goal, v_uid,
          (select array_agg(distinct x::smallint order by x::smallint) from jsonb_array_elements_text(p -> 'rule' -> 'weekdays') x),
          (p -> 'rule' ->> 'start_time')::time,
          (p -> 'rule' ->> 'duration_min')::int,
          coalesce((p -> 'rule' ->> 'lead_min')::int, 10),
          coalesce((p -> 'rule' ->> 'call_lead_min')::int, 0));

  return jsonb_build_object(
    'goal_id', v_goal,
    'conflicts', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from generate_blocks(14, v_goal) c));
end $$;

create or replace function update_rule(p_goal uuid, p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare v_uid text := require_user();
begin
  update schedule_rules set
    weekdays     = coalesce((select array_agg(distinct x::smallint order by x::smallint) from jsonb_array_elements_text(p -> 'weekdays') x), weekdays),
    start_time   = coalesce((p ->> 'start_time')::time, start_time),
    duration_min = coalesce((p ->> 'duration_min')::int, duration_min),
    lead_min     = coalesce((p ->> 'lead_min')::int, lead_min),
    call_lead_min = coalesce((p ->> 'call_lead_min')::int, call_lead_min)
  where goal_id = p_goal and user_id = v_uid;
  if not found then
    raise exception 'goal not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'goal_id', p_goal,
    'conflicts', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from regenerate_goal(p_goal) c));
end $$;
