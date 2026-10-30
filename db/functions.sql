-- DeepWork — database functions. Safe to re-run (create or replace).
--
-- User-facing functions are SECURITY INVOKER, so RLS applies, and they also filter on
-- current_uid() explicitly. The few SECURITY DEFINER functions are listed at the end;
-- each one either acts only on current_uid() or is executable by the dispatcher only.

-- ───────────────────────── types
do $$
begin
  if not exists (select 1 from pg_type where typname = 'gen_conflict') then
    create type gen_conflict as (
      kind            text,         -- 'session' | 'commitment'
      ref_id          uuid,         -- goal id or commitment id
      title           text,
      starts_at       timestamptz,
      ends_at         timestamptz,
      clash_id        uuid,
      clash_title     text,
      clash_starts_at timestamptz,
      clash_ends_at   timestamptz
    );
  end if;
end $$;

-- ───────────────────────── small helpers
create or replace function require_user() returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare v text := current_uid();
begin
  if v is null or v = '' then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return v;
end $$;

create or replace function my_tz() returns text
language sql stable set search_path = public, pg_temp as $$
  select coalesce((select timezone from profiles where user_id = current_uid()), 'Asia/Karachi')
$$;

-- True when [p_start, p_end) touches the quiet window (which may wrap midnight).
create or replace function in_quiet_hours(p_start timestamptz, p_end timestamptz,
                                          p_tz text, p_qs time, p_qe time) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select case when p_qs = p_qe then false else exists (
    select 1
      from generate_series((p_start at time zone p_tz)::date - 1,
                           (p_end at time zone p_tz)::date, interval '1 day') d
     where tsrange(d::date + p_qs,
                   case when p_qs > p_qe then (d::date + 1) + p_qe else d::date + p_qe end, '[)')
        && tsrange(p_start at time zone p_tz, p_end at time zone p_tz, '[)')
  ) end
$$;

-- ───────────────────────── clash checks used by the UI and the assistant
create or replace function find_clash(p_start timestamptz, p_end timestamptz, p_ignore uuid default null)
returns table (id uuid, title text, kind text, starts_at timestamptz, ends_at timestamptz)
language sql stable security invoker set search_path = public, pg_temp as $$
  select b.id, b.title, b.kind, lower(b.period), upper(b.period)
    from calendar_blocks b
   where b.user_id = current_uid()
     and b.status not in ('cancelled', 'skipped')
     and b.period && tstzrange(p_start, p_end, '[)')
     and (p_ignore is null or b.id <> p_ignore)
   order by lower(b.period)
   limit 3
$$;

-- Like find_clash, but can also ignore the blocks a change would replace:
-- a goal's future generated sessions (rule change) or a commitment's future occurrences.
create or replace function find_clashes(p_start timestamptz, p_end timestamptz,
                                        p_ignore_ids uuid[] default '{}',
                                        p_ignore_goal uuid default null,
                                        p_ignore_commitment uuid default null)
returns table (id uuid, title text, kind text, starts_at timestamptz, ends_at timestamptz)
language sql stable security invoker set search_path = public, pg_temp as $$
  select b.id, b.title, b.kind, lower(b.period), upper(b.period)
    from calendar_blocks b
   where b.user_id = current_uid()
     and b.status not in ('cancelled', 'skipped')
     and b.period && tstzrange(p_start, p_end, '[)')
     and not (b.id = any (coalesce(p_ignore_ids, '{}')))
     and not (p_ignore_goal is not null and b.goal_id = p_ignore_goal and b.status = 'planned'
              and b.created_by = 'generator' and lower(b.period) = b.slot_start and lower(b.period) > now())
     and not (p_ignore_commitment is not null and b.commitment_id = p_ignore_commitment
              and b.status = 'planned' and upper(b.period) > now())
   order by lower(b.period)
   limit 3
$$;

-- First free starts of at least p_duration_min between p_from and p_to, on a p_step_min
-- grid in local time, outside quiet hours.
create or replace function free_slots(p_duration_min int, p_from timestamptz, p_to timestamptz,
                                      p_limit int default 3, p_ignore uuid default null,
                                      p_step_min int default 30)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_uid  text := require_user();
  v_tz   text := 'Asia/Karachi';
  v_qs   time := '23:00';
  v_qe   time := '07:00';
  v_dur  interval := make_interval(mins => p_duration_min);
  v_step interval := make_interval(mins => greatest(p_step_min, 5));
  v_from timestamptz := greatest(p_from, now());
  s      timestamptz;
  n      int := 0;
begin
  select p.timezone, p.quiet_start, p.quiet_end into v_tz, v_qs, v_qe
    from profiles p where p.user_id = v_uid;
  v_tz := coalesce(v_tz, 'Asia/Karachi');
  v_qs := coalesce(v_qs, '23:00');
  v_qe := coalesce(v_qe, '07:00');
  -- round up to the grid, measured from local midnight
  s := date_bin(v_step, v_from + v_step - interval '1 microsecond',
                (date_trunc('day', v_from at time zone v_tz)) at time zone v_tz);
  while s < p_to and n < least(p_limit, 50) loop
    if not in_quiet_hours(s, s + v_dur, v_tz, v_qs, v_qe)
       and not exists (
         select 1 from calendar_blocks b
          where b.user_id = v_uid and b.status not in ('cancelled', 'skipped')
            and b.period && tstzrange(s, s + v_dur, '[)')
            and (p_ignore is null or b.id <> p_ignore)) then
      starts_at := s;
      ends_at := s + v_dur;
      n := n + 1;
      return next;
    end if;
    s := s + v_step;
  end loop;
end $$;

-- ───────────────────────── the generator
-- Expands commitments, then each active goal's weekly rule, into calendar_blocks for the
-- next p_days local days (sessions stop at the goal's deadline). Idempotent: an existing
-- block for the same slot is left alone, even if it was moved, cancelled or done.
-- A slot that would overlap something is skipped and returned as a conflict; nothing is
-- ever double-booked (the no_overlap constraint is the final guard).
-- generate_blocks_for does the work for an explicit user so the nightly worker can run it
-- without touching request.jwt.claims (pg_session_jwt forbids that in definer functions).
-- Called as `authenticated` it is still bound by RLS, so it can only ever write the
-- caller's own rows.
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

  -- 2) Sessions from each active goal's weekly rule, up to its deadline.
  if p_commitment is null then
    for r in
      select g.id as goal_id, g.title, g.deadline, sr.weekdays, sr.start_time, sr.duration_min
        from goals g join schedule_rules sr on sr.goal_id = g.id
       where g.user_id = v_uid and g.status = 'active' and (p_goal is null or g.id = p_goal)
       order by g.created_at, g.id
    loop
      for d in
        select x::date from generate_series(v_today, least(r.deadline, v_today + (p_days - 1)),
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

create or replace function generate_blocks(p_days int default 14,
                                           p_goal uuid default null,
                                           p_commitment uuid default null,
                                           p_now timestamptz default now())
returns setof gen_conflict
language sql volatile security invoker set search_path = public, pg_temp as $$
  select * from generate_blocks_for(require_user(), p_days, p_goal, p_commitment, p_now)
$$;

-- After a rule edit: drop only this goal's future, untouched generated sessions, then
-- regenerate. Moved, done, skipped or cancelled sessions are kept.
create or replace function regenerate_goal(p_goal uuid, p_days int default 14,
                                           p_now timestamptz default now())
returns setof gen_conflict
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare v_uid text := require_user();
begin
  delete from calendar_blocks b
   where b.user_id = v_uid and b.goal_id = p_goal and b.kind = 'session'
     and b.status = 'planned' and b.created_by = 'generator'
     and lower(b.period) = b.slot_start and lower(b.period) > p_now;
  return query select * from generate_blocks(p_days, p_goal, null, p_now);
end $$;

-- After a commitment edit: drop its future planned occurrences, then regenerate.
create or replace function regenerate_commitment(p_commitment uuid, p_days int default 14,
                                                 p_now timestamptz default now())
returns setof gen_conflict
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare v_uid text := require_user();
begin
  delete from calendar_blocks b
   where b.user_id = v_uid and b.commitment_id = p_commitment
     and b.status = 'planned' and lower(b.period) > p_now;
  return query select * from generate_blocks(p_days, null, p_commitment, p_now);
end $$;

-- Pausing or finishing a goal clears its future sessions; resuming regenerates them.
create or replace function set_goal_status(p_goal uuid, p_status text)
returns setof gen_conflict
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare v_uid text := require_user();
begin
  update goals set status = p_status where id = p_goal and user_id = v_uid;
  if not found then
    raise exception 'goal not found' using errcode = 'P0002';
  end if;
  if p_status = 'active' then
    return query select * from generate_blocks(14, p_goal, null);
  else
    delete from calendar_blocks b
     where b.user_id = v_uid and b.goal_id = p_goal
       and b.status in ('planned', 'snoozed') and lower(b.period) > now();
  end if;
end $$;

-- Sessions that ended more than 30 minutes ago and were never started become missed.
-- Called on every block read so the Today card works even without the cron job.
create or replace function mark_my_missed() returns int
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare n int;
begin
  update calendar_blocks
     set status = 'missed'
   where user_id = current_uid() and kind = 'session'
     and status in ('planned', 'snoozed') and upper(period) + interval '30 minutes' < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────────────────────── stats for Insights
-- Consecutive sessions shown up for, counting back from the latest finished one.
create or replace function my_streak()
returns table (streak int, since timestamptz)
language sql stable security invoker set search_path = public, pg_temp as $$
  with s as (
    select status, lower(period) as st
      from calendar_blocks
     where user_id = current_uid() and kind = 'session'
       and status in ('done', 'missed', 'skipped') and lower(period) <= now()
  ), w as (
    select status, st,
           sum(case when status <> 'done' then 1 else 0 end) over (order by st desc) as breaks
      from s
  )
  select count(*)::int, min(st) from w where breaks = 0
$$;

-- ───────────────────────── assistant apply / undo
-- The planner stores resolved actions (concrete UTC times, checked ids) in
-- assistant_runs.checks. Apply runs only the requested indexes whose status is 'ok',
-- in one transaction. Any overlap raises 23P01 and rolls everything back.
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
     order by t.ord
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
        if exists (select 1 from generate_blocks(14, null, v_id)) then
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

create or replace function assistant_undo(p_run uuid)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_uid text := require_user();
  v_run assistant_runs;
  op    jsonb;
  v_rule schedule_rules;
begin
  select * into v_run from assistant_runs where id = p_run and user_id = v_uid for update;
  if not found then
    raise exception 'assistant run not found' using errcode = 'P0002';
  end if;
  if v_run.applied_at is null or v_run.undone_at is not null then
    raise exception 'nothing to undo' using errcode = 'P0001';
  end if;
  if now() > v_run.undo_until then
    raise exception 'the undo window has passed' using errcode = 'P0001';
  end if;

  for op in
    select t.value from jsonb_array_elements(v_run.undo_payload) with ordinality as t(value, ord)
     order by t.ord desc
  loop
    case op ->> 'op'
      when 'delete_commitment' then
        delete from commitments where id = (op ->> 'id')::uuid and user_id = v_uid;
      when 'delete_block' then
        delete from calendar_blocks where id = (op ->> 'id')::uuid and user_id = v_uid;
      when 'restore_block' then
        update calendar_blocks
           set period = (op ->> 'period')::tstzrange, status = op ->> 'status'
         where id = (op ->> 'id')::uuid and user_id = v_uid;
      when 'restore_commitment' then
        insert into commitments select * from jsonb_populate_record(null::commitments, op -> 'row');
        insert into calendar_blocks select * from jsonb_populate_recordset(null::calendar_blocks, op -> 'blocks');
      when 'restore_rule' then
        v_rule := jsonb_populate_record(null::schedule_rules, op -> 'row');
        update schedule_rules
           set weekdays = v_rule.weekdays, start_time = v_rule.start_time,
               duration_min = v_rule.duration_min, lead_min = v_rule.lead_min
         where goal_id = v_rule.goal_id and user_id = v_uid;
        perform regenerate_goal(v_rule.goal_id);
      else
        null;
    end case;
  end loop;

  update assistant_runs set undone_at = now() where id = p_run;
  return jsonb_build_object('undone', true);
end $$;

-- ───────────────────────── export
create or replace function export_my_data() returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from profiles p where p.user_id = current_uid()),
    'goals', (select coalesce(jsonb_agg(to_jsonb(g) order by g.created_at), '[]') from goals g where g.user_id = current_uid()),
    'milestones', (select coalesce(jsonb_agg(to_jsonb(m) order by m.goal_id, m.position), '[]') from milestones m where m.user_id = current_uid()),
    'schedule_rules', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from schedule_rules r where r.user_id = current_uid()),
    'commitments', (select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at), '[]') from commitments c where c.user_id = current_uid()),
    'calendar_blocks', (select coalesce(jsonb_agg(to_jsonb(b) order by lower(b.period)), '[]') from calendar_blocks b where b.user_id = current_uid()),
    'devices', (select coalesce(jsonb_agg(jsonb_build_object('platform', d.platform, 'updated_at', d.updated_at)), '[]') from devices d where d.user_id = current_uid()),
    'assistant_runs', (select coalesce(jsonb_agg(to_jsonb(a) - 'undo_payload' order by a.created_at), '[]') from assistant_runs a where a.user_id = current_uid())
  )
$$;

-- ───────────────────────── SECURITY DEFINER functions
-- Delete account: removes every row of the caller and their Neon Auth user (sessions
-- and accounts cascade). Runs as the owner because neon_auth is not granted to the API.
create or replace function delete_my_account() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_uid text := require_user();
begin
  delete from assistant_runs    where user_id = v_uid;
  delete from notification_jobs where user_id = v_uid;
  delete from devices           where user_id = v_uid;
  delete from calendar_blocks   where user_id = v_uid;
  delete from commitments       where user_id = v_uid;
  delete from goals             where user_id = v_uid;   -- milestones and rules cascade
  delete from profiles          where user_id = v_uid;
  if to_regclass('neon_auth."user"') is not null then
    execute 'delete from neon_auth."user" where id::text = $1' using v_uid;
  end if;
  return jsonb_build_object('deleted', true);
end $$;
revoke all on function delete_my_account() from public;
grant execute on function delete_my_account() to authenticated;

-- Cron: mark missed sessions for everyone, and close sessions left running for hours.
create or replace function worker_mark_missed() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n_missed int; n_closed int;
begin
  update calendar_blocks
     set status = 'missed'
   where kind = 'session' and status in ('planned', 'snoozed')
     and upper(period) + interval '30 minutes' < now();
  get diagnostics n_missed = row_count;

  update calendar_blocks
     set status = 'done',
         finished_at = upper(period),
         minutes_done = coalesce(minutes_done, greatest(0, least(1440,
           (extract(epoch from (upper(period) - greatest(coalesce(started_at, lower(period)), lower(period)))) / 60)::int)))
   where kind = 'session' and status = 'in_progress'
     and upper(period) + interval '6 hours' < now();
  get diagnostics n_closed = row_count;

  return jsonb_build_object('missed', n_missed, 'closed', n_closed);
end $$;

-- Cron (nightly): keep every user's 14-day horizon filled.
create or replace function worker_extend_horizon() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare p record; n int := 0; c int := 0; k int;
begin
  for p in select user_id from profiles loop
    select count(*) into k from generate_blocks_for(p.user_id, 14);
    n := n + 1;
    c := c + k;
  end loop;
  return jsonb_build_object('users', n, 'conflicts', c);
end $$;

-- Cron (every minute, only when FCM is configured): claim due pushes for users with a
-- registered device. Quiet hours skip everything except the start push; max 6 a day.
create or replace function worker_claim_pushes() returns table (
  job_id bigint, user_id text, kind text, block_id uuid, title text, starts_at timestamptz,
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
  select cl.id, cl.user_id, cl.kind, cl.block_id, b.title, lower(b.period), upper(b.period),
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

create or replace function worker_finish_pushes(p_sent bigint[], p_failed bigint[], p_bad_tokens text[])
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n_bad int;
begin
  update notification_jobs set sent_at = now(), last_error = null where id = any (coalesce(p_sent, '{}'));
  update notification_jobs set last_error = 'send failed' where id = any (coalesce(p_failed, '{}'));
  delete from devices where fcm_token = any (coalesce(p_bad_tokens, '{}'));
  get diagnostics n_bad = row_count;
  return jsonb_build_object('removed_tokens', n_bad);
end $$;

do $$
declare f text;
begin
  foreach f in array array['worker_mark_missed()', 'worker_extend_horizon()', 'worker_claim_pushes()',
                           'worker_finish_pushes(bigint[], bigint[], text[])']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to dispatcher', f);
  end loop;
end $$;
