-- DeepWork — functions the `api` Edge Function calls through the Neon Data API (RPC).
-- Each call is one transaction, runs as the signed-in user (RLS applies), and returns
-- JSON. Overlaps surface as SQLSTATE 23P01 with a JSON `detail` naming the clash.
-- Safe to re-run.

-- ───────────────────────── helpers
create or replace function is_valid_tz(p_tz text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz)
$$;

-- Raise the friendly clash error for a period, naming what is already there.
create or replace function raise_clash(p_start timestamptz, p_end timestamptz, p_ignore uuid default null)
returns void
language plpgsql stable set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from find_clash(p_start, p_end, p_ignore) limit 1;
  raise exception 'That time is taken.' using errcode = '23P01',
    detail = coalesce(jsonb_build_object('id', c.id, 'title', c.title, 'kind', c.kind,
                                         'starts_at', c.starts_at, 'ends_at', c.ends_at)::text, '{}');
end $$;

create or replace function block_json(b calendar_blocks) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', b.id, 'kind', b.kind, 'goal_id', b.goal_id, 'commitment_id', b.commitment_id,
    'title', b.title, 'starts_at', lower(b.period), 'ends_at', upper(b.period),
    'slot_start', b.slot_start, 'status', b.status, 'minutes_done', b.minutes_done,
    'note', b.note, 'started_at', b.started_at, 'finished_at', b.finished_at,
    'created_by', b.created_by)
$$;

-- ───────────────────────── profile + everything the app shows, in one round trip
create or replace function ensure_profile(p_display_name text default '', p_timezone text default null)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare v_uid text := require_user(); v profiles;
begin
  insert into profiles (user_id, display_name, timezone)
  values (v_uid, left(coalesce(p_display_name, ''), 80),
          case when is_valid_tz(p_timezone) then p_timezone else 'Asia/Karachi' end)
  on conflict (user_id) do nothing;
  select * into v from profiles where user_id = v_uid;
  return to_jsonb(v);
end $$;

-- Marks missed sessions, keeps the 14-day horizon filled, then returns the profile,
-- goals (with plan, rhythm and progress), commitments, blocks in [p_from, p_to),
-- generator conflicts and the current streak.
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
               'id', g.id, 'title', g.title, 'why', g.why, 'deadline', g.deadline,
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

create or replace function list_blocks(p_from timestamptz, p_to timestamptz, p_goal uuid default null)
returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(block_json(b) order by lower(b.period)), '[]')
    from calendar_blocks b
   where b.user_id = current_uid() and b.period && tstzrange(p_from, p_to, '[)')
     and (p_goal is null or b.goal_id = p_goal)
$$;

-- Most recent finished sessions of a goal (Goal detail › Recent sessions).
create or replace function recent_sessions(p_goal uuid, p_limit int default 10)
returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x.j order by x.st desc), '[]') from (
    select block_json(b) as j, lower(b.period) as st
      from calendar_blocks b
     where b.user_id = current_uid() and b.goal_id = p_goal and lower(b.period) <= now()
       and b.status in ('done', 'missed', 'skipped', 'in_progress')
     order by lower(b.period) desc
     limit least(greatest(p_limit, 1), 50)) x
$$;

create or replace function update_profile(p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare v_uid text := require_user(); v_old profiles; v profiles;
begin
  select * into v_old from profiles where user_id = v_uid;
  if not found then
    perform ensure_profile();
    select * into v_old from profiles where user_id = v_uid;
  end if;
  if p ? 'timezone' and not is_valid_tz(p ->> 'timezone') then
    raise exception 'Unknown time zone' using errcode = '22023';
  end if;
  update profiles set
    display_name          = case when p ? 'display_name' then left(coalesce(p ->> 'display_name', ''), 80) else display_name end,
    timezone              = case when p ? 'timezone' then p ->> 'timezone' else timezone end,
    language              = case when p ? 'language' then p ->> 'language' else language end,
    quiet_start           = case when p ? 'quiet_start' then (p ->> 'quiet_start')::time else quiet_start end,
    quiet_end             = case when p ? 'quiet_end' then (p ->> 'quiet_end')::time else quiet_end end,
    briefing_at           = case when p ? 'briefing_at' then (p ->> 'briefing_at')::time else briefing_at end,
    theme                 = case when p ? 'theme' then p ->> 'theme' else theme end,
    notifications_enabled = case when p ? 'notifications_enabled' then (p ->> 'notifications_enabled')::boolean else notifications_enabled end,
    hide_titles           = case when p ? 'hide_titles' then (p ->> 'hide_titles')::boolean else hide_titles end,
    speak_replies         = case when p ? 'speak_replies' then (p ->> 'speak_replies')::boolean else speak_replies end,
    assistant_auto_apply  = case when p ? 'assistant_auto_apply' then (p ->> 'assistant_auto_apply')::boolean else assistant_auto_apply end,
    onboarded_at          = case when (p ->> 'onboarded')::boolean is true then coalesce(onboarded_at, now()) else onboarded_at end
  where user_id = v_uid
  returning * into v;

  -- A new time zone moves every future generated block to the same local times.
  if v.timezone is distinct from v_old.timezone then
    delete from calendar_blocks b
     where b.user_id = v_uid and b.status = 'planned' and b.created_by = 'generator'
       and lower(b.period) = b.slot_start and lower(b.period) > now();
    perform generate_blocks(14);
  end if;
  return to_jsonb(v);
end $$;

-- ───────────────────────── goals
-- p = {title, why, deadline, milestones:[{title}], rule:{weekdays,start_time,duration_min,lead_min}}
create or replace function create_goal(p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid  text := require_user();
  v_goal uuid;
  i      int := 0;
  m      jsonb;
begin
  if (p ->> 'deadline')::date <= (now() at time zone my_tz())::date then
    raise exception 'The deadline must be tomorrow or later.' using errcode = '22023';
  end if;
  insert into goals (user_id, title, why, deadline)
  values (v_uid, btrim(p ->> 'title'), nullif(btrim(coalesce(p ->> 'why', '')), ''), (p ->> 'deadline')::date)
  returning id into v_goal;

  for m in select value from jsonb_array_elements(coalesce(p -> 'milestones', '[]')) loop
    continue when btrim(coalesce(m ->> 'title', '')) = '';
    insert into milestones (user_id, goal_id, position, title) values (v_uid, v_goal, i, btrim(m ->> 'title'));
    i := i + 1;
  end loop;

  insert into schedule_rules (goal_id, user_id, weekdays, start_time, duration_min, lead_min)
  values (v_goal, v_uid,
          (select array_agg(distinct x::smallint order by x::smallint) from jsonb_array_elements_text(p -> 'rule' -> 'weekdays') x),
          (p -> 'rule' ->> 'start_time')::time,
          (p -> 'rule' ->> 'duration_min')::int,
          coalesce((p -> 'rule' ->> 'lead_min')::int, 10));

  return jsonb_build_object(
    'goal_id', v_goal,
    'conflicts', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from generate_blocks(14, v_goal) c));
end $$;

-- p may hold title, why, deadline, status. A new deadline regenerates future sessions.
create or replace function update_goal(p_goal uuid, p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid text := require_user();
  v_old goals;
  v_conflicts jsonb := '[]';
begin
  select * into v_old from goals where id = p_goal and user_id = v_uid for update;
  if not found then
    raise exception 'goal not found' using errcode = 'P0002';
  end if;
  update goals set
    title    = case when p ? 'title' then btrim(p ->> 'title') else title end,
    why      = case when p ? 'why' then nullif(btrim(coalesce(p ->> 'why', '')), '') else why end,
    deadline = case when p ? 'deadline' then (p ->> 'deadline')::date else deadline end
  where id = p_goal;

  if p ? 'status' and p ->> 'status' is distinct from v_old.status then
    select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_conflicts from set_goal_status(p_goal, p ->> 'status') c;
  elsif p ? 'deadline' and (p ->> 'deadline')::date is distinct from v_old.deadline then
    -- sessions after a shortened deadline go; an extended one gets new sessions
    delete from calendar_blocks b
     where b.user_id = v_uid and b.goal_id = p_goal and b.status in ('planned', 'snoozed')
       and lower(b.period) > now()
       and (lower(b.period) at time zone my_tz())::date > (p ->> 'deadline')::date;
    select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_conflicts from regenerate_goal(p_goal) c;
  end if;
  return jsonb_build_object('goal_id', p_goal, 'conflicts', v_conflicts);
end $$;

create or replace function update_rule(p_goal uuid, p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare v_uid text := require_user();
begin
  update schedule_rules set
    weekdays     = coalesce((select array_agg(distinct x::smallint order by x::smallint) from jsonb_array_elements_text(p -> 'weekdays') x), weekdays),
    start_time   = coalesce((p ->> 'start_time')::time, start_time),
    duration_min = coalesce((p ->> 'duration_min')::int, duration_min),
    lead_min     = coalesce((p ->> 'lead_min')::int, lead_min)
  where goal_id = p_goal and user_id = v_uid;
  if not found then
    raise exception 'goal not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'goal_id', p_goal,
    'conflicts', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from regenerate_goal(p_goal) c));
end $$;

-- Replace the plan with p_items = [{id?, title, done?}] in order. Kept ids keep their
-- done state unless `done` says otherwise.
create or replace function replace_milestones(p_goal uuid, p_items jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid  text := require_user();
  i      int := 0;
  m      jsonb;
  v_keep uuid[] := '{}';
  v_id   uuid;
begin
  perform 1 from goals where id = p_goal and user_id = v_uid;
  if not found then
    raise exception 'goal not found' using errcode = 'P0002';
  end if;
  set constraints milestones_goal_position deferred;
  for m in select value from jsonb_array_elements(coalesce(p_items, '[]')) loop
    continue when btrim(coalesce(m ->> 'title', '')) = '';
    v_id := null;
    if m ? 'id' and m ->> 'id' is not null then
      update milestones set position = i, title = btrim(m ->> 'title'),
             done_at = case when m ? 'done' then case when (m ->> 'done')::boolean then coalesce(done_at, now()) end else done_at end
       where id = (m ->> 'id')::uuid and goal_id = p_goal
      returning id into v_id;
    end if;
    if v_id is null then
      insert into milestones (user_id, goal_id, position, title, done_at)
      values (v_uid, p_goal, i, btrim(m ->> 'title'), case when (m ->> 'done')::boolean then now() end)
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id;
    i := i + 1;
  end loop;
  delete from milestones where goal_id = p_goal and not (id = any (v_keep));
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'position', position, 'title', title, 'done_at', done_at)
                          order by position), '[]') from milestones where goal_id = p_goal);
end $$;

create or replace function set_milestone_done(p_id uuid, p_done boolean) returns jsonb
language sql volatile security invoker set search_path = public, pg_temp as $$
  update milestones set done_at = case when p_done then coalesce(done_at, now()) end
   where id = p_id and user_id = current_uid()
  returning jsonb_build_object('id', id, 'done_at', done_at)
$$;

create or replace function delete_goal(p_goal uuid) returns jsonb
language sql volatile security invoker set search_path = public, pg_temp as $$
  delete from goals where id = p_goal and user_id = current_uid() returning jsonb_build_object('deleted', id)
$$;

-- ───────────────────────── clash checks for proposed slots
-- p_slots = [{starts_at, ends_at}] → [{index, clash:{id,title,kind,starts_at,ends_at}|null}]
create or replace function check_slots(p_slots jsonb, p_ignore_goal uuid default null,
                                       p_ignore_commitment uuid default null, p_ignore_ids uuid[] default '{}')
returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'index', s.ord - 1,
           'clash', (select to_jsonb(c) from find_clashes((s.value ->> 'starts_at')::timestamptz,
                                                          (s.value ->> 'ends_at')::timestamptz,
                                                          p_ignore_ids, p_ignore_goal, p_ignore_commitment) c limit 1))
         order by s.ord), '[]')
    from jsonb_array_elements(coalesce(p_slots, '[]')) with ordinality as s(value, ord)
$$;

-- ───────────────────────── commitments
-- p = {id?, title, weekdays[], start_time, duration_min, one_off_date?, starts_on?}
-- Saves and books the next 14 days in one go; any clash rolls it all back (23P01).
create or replace function save_commitment(p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid  text := require_user();
  v_id   uuid := (p ->> 'id')::uuid;
  v_days smallint[] := coalesce((select array_agg(distinct x::smallint order by x::smallint)
                                  from jsonb_array_elements_text(p -> 'weekdays') x), '{}');
  c      gen_conflict;
begin
  if v_id is null then
    insert into commitments (user_id, title, weekdays, start_time, duration_min, one_off_date, starts_on)
    values (v_uid, btrim(p ->> 'title'), v_days, (p ->> 'start_time')::time, (p ->> 'duration_min')::int,
            (p ->> 'one_off_date')::date,
            coalesce((p ->> 'starts_on')::date, case when (p ->> 'one_off_date') is null then (now() at time zone my_tz())::date end))
    returning id into v_id;
  else
    update commitments set
      title = btrim(p ->> 'title'), weekdays = v_days, start_time = (p ->> 'start_time')::time,
      duration_min = (p ->> 'duration_min')::int, one_off_date = (p ->> 'one_off_date')::date,
      starts_on = coalesce((p ->> 'starts_on')::date, starts_on)
    where id = v_id and user_id = v_uid;
    if not found then
      raise exception 'commitment not found' using errcode = 'P0002';
    end if;
    delete from calendar_blocks b
     where b.user_id = v_uid and b.commitment_id = v_id and b.status = 'planned' and lower(b.period) > now();
  end if;

  select * into c from generate_blocks(14, null, v_id) limit 1;
  if c.kind is not null then
    raise exception 'That time is taken.' using errcode = '23P01',
      detail = jsonb_build_object('id', c.clash_id, 'title', c.clash_title,
                                  'starts_at', c.clash_starts_at, 'ends_at', c.clash_ends_at,
                                  'slot_starts_at', c.starts_at, 'slot_ends_at', c.ends_at)::text;
  end if;
  return jsonb_build_object('commitment_id', v_id);
end $$;

create or replace function delete_commitment(p_id uuid) returns jsonb
language sql volatile security invoker set search_path = public, pg_temp as $$
  delete from commitments where id = p_id and user_id = current_uid() returning jsonb_build_object('deleted', id)
$$;

-- ───────────────────────── session actions
-- p_action: start | finish {minutes} | skip {reason} | snooze | move {starts_at} | cancel | restore
create or replace function block_action(p_id uuid, p_action text, p jsonb default '{}')
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid text := require_user();
  b     calendar_blocks;
  v_len interval;
  v_new timestamptz;
begin
  select * into b from calendar_blocks where id = p_id and user_id = v_uid for update;
  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  v_len := upper(b.period) - lower(b.period);

  case p_action
    when 'start' then
      update calendar_blocks set status = 'in_progress', started_at = coalesce(started_at, now())
       where id = p_id returning * into b;
    when 'finish' then
      update calendar_blocks
         set status = 'done', finished_at = now(),
             minutes_done = greatest(0, least(1440, coalesce((p ->> 'minutes')::int,
                              (extract(epoch from v_len) / 60)::int)))
       where id = p_id returning * into b;
    when 'skip' then
      update calendar_blocks set status = 'skipped', note = nullif(left(coalesce(p ->> 'reason', ''), 280), '')
       where id = p_id returning * into b;
    when 'cancel' then
      update calendar_blocks set status = 'cancelled' where id = p_id returning * into b;
    when 'snooze', 'move' then
      -- snoozing a session that is already due pushes it from now, not from its old start
      v_new := case when p_action = 'snooze'
                    then greatest(lower(b.period), now()) + make_interval(mins => coalesce((p ->> 'minutes')::int, 10))
                    else (p ->> 'starts_at')::timestamptz end;
      if v_new is null then
        raise exception 'a new start time is needed' using errcode = '22023';
      end if;
      if p_action = 'move' and v_new + v_len <= now() then
        raise exception 'Pick a time that has not passed yet.' using errcode = '22023';
      end if;
      begin
        update calendar_blocks
           set period = tstzrange(v_new, v_new + v_len, '[)'),
               status = case when p_action = 'snooze' then 'snoozed' else 'planned' end,
               started_at = null
         where id = p_id returning * into b;
      exception when exclusion_violation then
        perform raise_clash(v_new, v_new + v_len, p_id);
      end;
    when 'restore' then
      update calendar_blocks
         set status = coalesce(p ->> 'status', 'planned'),
             period = coalesce((p ->> 'period')::tstzrange, period)
       where id = p_id returning * into b;
    else
      raise exception 'unknown action %', p_action using errcode = '22023';
  end case;
  return block_json(b);
end $$;

-- ───────────────────────── devices (server push)
-- A token moves to whoever signs in on that phone last.
create or replace function register_device(p_token text, p_platform text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_uid text := require_user();
begin
  delete from devices where fcm_token = p_token and user_id <> v_uid;
  insert into devices (user_id, fcm_token, platform) values (v_uid, p_token, p_platform)
  on conflict (fcm_token) do update set updated_at = now(), platform = excluded.platform;
  return jsonb_build_object('registered', true);
end $$;
revoke all on function register_device(text, text) from public;
grant execute on function register_device(text, text) to authenticated;

create or replace function unregister_device(p_token text) returns jsonb
language sql volatile security invoker set search_path = public, pg_temp as $$
  delete from devices where fcm_token = p_token and user_id = current_uid()
  returning jsonb_build_object('removed', true)
$$;
