-- Goals get an optional start date (sessions begin on it), and lengths are freer:
-- sessions 10 minutes to 8 hours, commitments 5 minutes to 24 hours. A one-off past the
-- 14-day horizon is booked (and clash-checked) when it is saved. (Fresh installs get all
-- of this from schema.sql, functions.sql and api.sql.)

alter table goals add column if not exists start_date date;
alter table goals drop constraint if exists goals_start_before_deadline;
alter table goals add constraint goals_start_before_deadline check (start_date is null or start_date <= deadline);

alter table schedule_rules drop constraint if exists schedule_rules_duration_min_check;
alter table schedule_rules add constraint schedule_rules_duration_min_check check (duration_min between 10 and 480);
alter table commitments drop constraint if exists commitments_duration_min_check;
alter table commitments add constraint commitments_duration_min_check check (duration_min between 5 and 1440);


create or replace function generate_blocks_for(p_uid text,
                                               p_days int default 14,
                                               p_goal uuid default null,
                                               p_commitment uuid default null,
                                               p_now timestamptz default now())
returns setof gen_conflict
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid   text := p_uid;
  v_tz    text := coalesce((select timezone from profiles where user_id = p_uid), 'Asia/Karachi');
  v_now   timestamptz := p_now;
  v_today date;
  r       record;
  d       date;
  s       timestamptz;
  e       timestamptz;
  c       record;
  out     gen_conflict;
begin
  if v_uid is null or v_uid = '' then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  v_today := (p_now at time zone v_tz)::date;

  -- 1) Commitments first: they are fixed.
  if p_goal is null then
    for r in
      select cm.* from commitments cm
       where cm.user_id = v_uid and (p_commitment is null or cm.id = p_commitment)
       order by cm.created_at, cm.id
    loop
      for d in
        select x::date from generate_series(v_today, v_today + (p_days - 1), interval '1 day') x
      loop
        if r.one_off_date is not null then
          continue when d <> r.one_off_date;
        else
          continue when not (extract(dow from d)::smallint = any (r.weekdays));
          continue when r.starts_on is not null and d < r.starts_on;
        end if;
        s := (d + r.start_time) at time zone v_tz;
        e := s + make_interval(mins => r.duration_min);
        continue when e <= v_now;
        -- one occurrence per local day; a moved or cancelled one still counts
        continue when exists (select 1 from calendar_blocks b
                               where b.commitment_id = r.id
                                 and (b.slot_start at time zone v_tz)::date = d);
        begin
          insert into calendar_blocks (user_id, kind, commitment_id, title, period, slot_start, created_by)
          values (v_uid, 'commitment', r.id, r.title, tstzrange(s, e, '[)'), s, 'generator');
        exception
          when unique_violation then null;
          when exclusion_violation then
            select b.id, b.title, lower(b.period) as ls, upper(b.period) as us into c
              from calendar_blocks b
             where b.user_id = v_uid and b.status not in ('cancelled', 'skipped')
               and b.period && tstzrange(s, e, '[)')
             order by lower(b.period) limit 1;
            out := ('commitment', r.id, r.title, s, e, c.id, c.title, c.ls, c.us);
            return next out;
        end;
      end loop;
    end loop;
  end if;

  -- 2) Sessions from each active goal's weekly rule, from its start date to its deadline.
  if p_commitment is null then
    for r in
      select g.id as goal_id, g.title, g.start_date, g.deadline, sr.weekdays, sr.start_time, sr.duration_min
        from goals g join schedule_rules sr on sr.goal_id = g.id
       where g.user_id = v_uid and g.status = 'active' and (p_goal is null or g.id = p_goal)
       order by g.created_at, g.id
    loop
      for d in
        select x::date from generate_series(greatest(v_today, r.start_date),
                                            least(r.deadline, v_today + (p_days - 1)),
                                            interval '1 day') x
      loop
        continue when not (extract(dow from d)::smallint = any (r.weekdays));
        s := (d + r.start_time) at time zone v_tz;
        e := s + make_interval(mins => r.duration_min);
        continue when s <= v_now;
        -- one rule session per local day; a moved, cancelled or done one still counts
        continue when exists (select 1 from calendar_blocks b
                               where b.goal_id = r.goal_id
                                 and (b.slot_start at time zone v_tz)::date = d);
        begin
          insert into calendar_blocks (user_id, kind, goal_id, title, period, slot_start, created_by)
          values (v_uid, 'session', r.goal_id, r.title, tstzrange(s, e, '[)'), s, 'generator');
        exception
          when unique_violation then null;
          when exclusion_violation then
            select b.id, b.title, lower(b.period) as ls, upper(b.period) as us into c
              from calendar_blocks b
             where b.user_id = v_uid and b.status not in ('cancelled', 'skipped')
               and b.period && tstzrange(s, e, '[)')
             order by lower(b.period) limit 1;
            out := ('session', r.goal_id, r.title, s, e, c.id, c.title, c.ls, c.us);
            return next out;
        end;
      end loop;
    end loop;
  end if;
end $$;

create or replace function assistant_apply(p_run uuid, p_indexes int[])
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid     text := require_user();
  v_run     assistant_runs;
  a         jsonb;
  v_undo    jsonb := '[]'::jsonb;
  v_applied jsonb := '[]'::jsonb;
  v_id      uuid;
  v_block   calendar_blocks;
  v_cm      commitments;
  v_rule    schedule_rules;
  v_days    smallint[];
begin
  select * into v_run from assistant_runs where id = p_run and user_id = v_uid for update;
  if not found then
    raise exception 'assistant run not found' using errcode = 'P0002';
  end if;
  if v_run.applied_at is not null then
    raise exception 'these changes were already applied' using errcode = 'P0001';
  end if;

  for a in
    select t.value from jsonb_array_elements(v_run.checks) with ordinality as t(value, ord)
     where (t.ord - 1)::int = any (p_indexes) and t.value ->> 'status' = 'ok'
     order by case t.value ->> 'type'
                when 'cancel_session' then 0 when 'delete_commitment' then 0
                when 'move_session' then 1 when 'update_rule' then 2 else 3 end,
              t.ord
  loop
    case a ->> 'type'
      when 'add_commitment' then
        v_days := coalesce((select array_agg(x::smallint) from jsonb_array_elements_text(a -> 'repeat_weekdays') x), '{}');
        insert into commitments (user_id, title, weekdays, start_time, duration_min, one_off_date, starts_on, created_by)
        values (v_uid, a ->> 'title', v_days, (a ->> 'local_start_time')::time, (a ->> 'duration_min')::int,
                case when cardinality(v_days) = 0 then (a ->> 'local_date')::date end,
                case when cardinality(v_days) > 0 then (a ->> 'local_date')::date end,
                'assistant')
        returning id into v_id;
        -- a one-off past the 14-day horizon is booked right away too
        if exists (select 1 from generate_blocks(greatest(14, (a ->> 'local_date')::date
                                                              - (now() at time zone my_tz())::date + 1),
                                                 null, v_id)) then
          raise exception 'That time is taken.' using errcode = '23P01';
        end if;
        v_undo := v_undo || jsonb_build_object('op', 'delete_commitment', 'id', v_id);

      when 'add_session' then
        v_id := null;
        insert into calendar_blocks (user_id, kind, goal_id, title, period, created_by)
        select v_uid, 'session', g.id, g.title,
               tstzrange((a ->> 'starts_at')::timestamptz, (a ->> 'ends_at')::timestamptz, '[)'), 'assistant'
          from goals g where g.id = (a ->> 'goal_id')::uuid and g.user_id = v_uid
        returning id into v_id;
        if v_id is null then
          raise exception 'goal not found' using errcode = 'P0002';
        end if;
        v_undo := v_undo || jsonb_build_object('op', 'delete_block', 'id', v_id);

      when 'move_session' then
        select * into v_block from calendar_blocks
         where id = (a ->> 'session_id')::uuid and user_id = v_uid and kind = 'session' for update;
        if not found then
          raise exception 'session not found' using errcode = 'P0002';
        end if;
        update calendar_blocks
           set period = tstzrange((a ->> 'starts_at')::timestamptz, (a ->> 'ends_at')::timestamptz, '[)'),
               status = 'planned'
         where id = v_block.id;
        v_undo := v_undo || jsonb_build_object('op', 'restore_block', 'id', v_block.id,
                                               'period', v_block.period::text, 'status', v_block.status);
        v_id := v_block.id;

      when 'cancel_session' then
        select * into v_block from calendar_blocks
         where id = (a ->> 'session_id')::uuid and user_id = v_uid and kind = 'session' for update;
        if not found then
          raise exception 'session not found' using errcode = 'P0002';
        end if;
        update calendar_blocks set status = 'cancelled' where id = v_block.id;
        v_undo := v_undo || jsonb_build_object('op', 'restore_block', 'id', v_block.id,
                                               'period', v_block.period::text, 'status', v_block.status);
        v_id := v_block.id;

      when 'delete_commitment' then
        if a ->> 'scope' = 'one' then
          select * into v_block from calendar_blocks
           where id = (a ->> 'occurrence_id')::uuid and user_id = v_uid and kind = 'commitment' for update;
          if not found then
            raise exception 'that occurrence was not found' using errcode = 'P0002';
          end if;
          update calendar_blocks set status = 'cancelled' where id = v_block.id;
          v_undo := v_undo || jsonb_build_object('op', 'restore_block', 'id', v_block.id,
                                                 'period', v_block.period::text, 'status', v_block.status);
          v_id := v_block.id;
        else
          select * into v_cm from commitments
           where id = (a ->> 'commitment_id')::uuid and user_id = v_uid for update;
          if not found then
            raise exception 'commitment not found' using errcode = 'P0002';
          end if;
          v_undo := v_undo || jsonb_build_object(
            'op', 'restore_commitment', 'row', to_jsonb(v_cm),
            'blocks', (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb)
                         from calendar_blocks b where b.commitment_id = v_cm.id));
          delete from commitments where id = v_cm.id;
          v_id := v_cm.id;
        end if;

      when 'update_rule' then
        select * into v_rule from schedule_rules
         where goal_id = (a ->> 'goal_id')::uuid and user_id = v_uid for update;
        if not found then
          raise exception 'that goal has no rhythm yet' using errcode = 'P0002';
        end if;
        v_undo := v_undo || jsonb_build_object('op', 'restore_rule', 'row', to_jsonb(v_rule));
        update schedule_rules
           set weekdays     = coalesce((select array_agg(x::smallint) from jsonb_array_elements_text(a -> 'rule' -> 'weekdays') x), weekdays),
               start_time   = coalesce((a -> 'rule' ->> 'start_time')::time, start_time),
               duration_min = coalesce((a -> 'rule' ->> 'duration_min')::int, duration_min),
               lead_min     = coalesce((a -> 'rule' ->> 'lead_min')::int, lead_min)
         where goal_id = v_rule.goal_id;
        if exists (select 1 from regenerate_goal(v_rule.goal_id)) then
          raise exception 'That time is taken.' using errcode = '23P01';
        end if;
        v_id := v_rule.goal_id;

      else
        continue;  -- clarify / none carry no change
    end case;
    v_applied := v_applied || jsonb_build_object('index', a -> 'index', 'type', a ->> 'type', 'id', v_id);
  end loop;

  update assistant_runs
     set applied_at = now(),
         -- the app shows a 10 second undo bar; a little grace covers network time
         undo_until = now() + interval '12 seconds',
         undo_payload = v_undo
   where id = p_run;

  return jsonb_build_object('applied', v_applied, 'undo_until', now() + interval '12 seconds');
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

create or replace function update_goal(p_goal uuid, p jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid       text := require_user();
  v_old       goals;
  v_new       goals;
  v_start     date;
  v_deadline  date;
  v_conflicts jsonb := '[]';
begin
  select * into v_old from goals where id = p_goal and user_id = v_uid for update;
  if not found then
    raise exception 'goal not found' using errcode = 'P0002';
  end if;
  v_start := case when p ? 'start_date' then nullif(p ->> 'start_date', '')::date else v_old.start_date end;
  v_deadline := case when p ? 'deadline' then (p ->> 'deadline')::date else v_old.deadline end;
  if v_start > v_deadline then
    raise exception 'The start date must be on or before the deadline.' using errcode = '22023';
  end if;
  update goals set
    title      = case when p ? 'title' then btrim(p ->> 'title') else title end,
    why        = case when p ? 'why' then nullif(btrim(coalesce(p ->> 'why', '')), '') else why end,
    start_date = v_start,
    deadline   = v_deadline
  where id = p_goal
  returning * into v_new;

  if p ? 'status' and p ->> 'status' is distinct from v_old.status then
    select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_conflicts from set_goal_status(p_goal, p ->> 'status') c;
  elsif v_new.deadline is distinct from v_old.deadline or v_new.start_date is distinct from v_old.start_date then
    -- sessions outside the new dates go; days newly inside them get sessions
    delete from calendar_blocks b
     where b.user_id = v_uid and b.goal_id = p_goal and b.status in ('planned', 'snoozed')
       and lower(b.period) > now()
       and ((lower(b.period) at time zone my_tz())::date > v_new.deadline
            or (lower(b.period) at time zone my_tz())::date < v_new.start_date);
    select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_conflicts from regenerate_goal(p_goal) c;
  end if;
  return jsonb_build_object('goal_id', p_goal, 'conflicts', v_conflicts);
end $$;

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

  -- a one-off past the 14-day horizon is booked (and checked) right away too
  select * into c from generate_blocks(greatest(14, (p ->> 'one_off_date')::date - (now() at time zone my_tz())::date + 1),
                                       null, v_id) limit 1;
  if c.kind is not null then
    raise exception 'That time is taken.' using errcode = '23P01',
      detail = jsonb_build_object('id', c.clash_id, 'title', c.clash_title,
                                  'starts_at', c.clash_starts_at, 'ends_at', c.clash_ends_at,
                                  'slot_starts_at', c.starts_at, 'slot_ends_at', c.ends_at)::text;
  end if;
  return jsonb_build_object('commitment_id', v_id);
end $$;
