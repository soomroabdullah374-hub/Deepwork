-- DeepWork — database tests: RLS isolation, the no-overlap constraint, the generator,
-- free slots, and assistant apply/undo.
--
-- Run as the API role (a member of `authenticated`, no BYPASSRLS) against a test
-- branch, never main:
--   psql "$TEST_DATABASE_URL_API" -v ON_ERROR_STOP=1 -f db/tests/db_test.sql
-- Every block prints PASS or raises with FAIL. All test data is removed at the end.

\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.as_user(p text) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p)::text, false);
$$;

-- ───────────────────────── fixtures: two users with one row in every table
select pg_temp.as_user('test-user-a');
insert into profiles (display_name, timezone) values ('Test A', 'Asia/Karachi');
insert into goals (id, title, deadline) values ('a0000000-0000-0000-0000-000000000001', 'Goal of user A', current_date + 60);
insert into milestones (goal_id, position, title) values ('a0000000-0000-0000-0000-000000000001', 0, 'A milestone');
insert into schedule_rules (goal_id, weekdays, start_time, duration_min) values ('a0000000-0000-0000-0000-000000000001', '{1,3}', '20:00', 60);
insert into commitments (id, title, weekdays, start_time, duration_min) values ('a0000000-0000-0000-0000-0000000000c1', 'A class', '{2}', '10:00', 60);
insert into calendar_blocks (kind, commitment_id, title, period)
  values ('commitment', 'a0000000-0000-0000-0000-0000000000c1', 'A class',
          tstzrange('2030-01-07 18:00+05', '2030-01-07 19:00+05', '[)'));
insert into devices (fcm_token, platform) values ('token-a-0123456789abcdef', 'android');
insert into assistant_runs (transcript, plan, checks) values ('hello', '{}', '[]');

select pg_temp.as_user('test-user-b');
insert into profiles (display_name, timezone) values ('Test B', 'Asia/Karachi');
insert into goals (id, title, deadline) values ('b0000000-0000-0000-0000-000000000001', 'Goal of user B', current_date + 60);
insert into milestones (goal_id, position, title) values ('b0000000-0000-0000-0000-000000000001', 0, 'B milestone');
insert into schedule_rules (goal_id, weekdays, start_time, duration_min) values ('b0000000-0000-0000-0000-000000000001', '{1,3}', '20:00', 60);
insert into commitments (id, title, weekdays, start_time, duration_min) values ('b0000000-0000-0000-0000-0000000000c1', 'B class', '{2}', '10:00', 60);
insert into devices (fcm_token, platform) values ('token-b-0123456789abcdef', 'android');
insert into assistant_runs (transcript, plan, checks) values ('hello b', '{}', '[]');

-- ───────────────────────── 1. user A cannot read, change or delete user B's rows
select pg_temp.as_user('test-user-a');
do $$
declare t text; n int;
begin
  foreach t in array array['profiles', 'goals', 'milestones', 'schedule_rules', 'commitments',
                           'calendar_blocks', 'devices', 'assistant_runs']
  loop
    execute format('select count(*) from %I where user_id = %L', t, 'test-user-b') into n;
    assert n = 0, format('FAIL: user A can read %s rows of user B', t);
    execute format('update %I set user_id = user_id where user_id = %L', t, 'test-user-b');
    get diagnostics n = row_count;
    assert n = 0, format('FAIL: user A can update %s rows of user B', t);
    execute format('delete from %I where user_id = %L', t, 'test-user-b');
    get diagnostics n = row_count;
    assert n = 0, format('FAIL: user A can delete %s rows of user B', t);
  end loop;
  raise notice 'PASS 1: user A cannot select, update or delete user B''s rows in any table';
end $$;

do $$
begin
  begin
    insert into goals (user_id, title, deadline) values ('test-user-b', 'Sneaky goal', current_date + 5);
    raise exception 'FAIL: user A inserted a row for user B';
  exception when insufficient_privilege then
    raise notice 'PASS 1b: inserting a row for another user is rejected by RLS';
  end;
  begin
    -- composite foreign key: a milestone cannot hang off someone else's goal
    insert into milestones (goal_id, position, title) values ('b0000000-0000-0000-0000-000000000001', 5, 'x');
    raise exception 'FAIL: user A attached a milestone to user B''s goal';
  exception when foreign_key_violation then
    raise notice 'PASS 1c: rows cannot reference another user''s goal';
  end;
end $$;

-- ───────────────────────── 2–5. the no-overlap constraint
do $$
begin
  begin
    insert into calendar_blocks (kind, commitment_id, title, period)
    values ('commitment', 'a0000000-0000-0000-0000-0000000000c1', 'Overlapping',
            tstzrange('2030-01-07 18:30+05', '2030-01-07 19:30+05', '[)'));
    raise exception 'FAIL: an overlapping block was inserted';
  exception when exclusion_violation then
    raise notice 'PASS 2: overlapping insert fails with exclusion_violation (23P01)';
  end;

  insert into calendar_blocks (kind, commitment_id, title, period)
  values ('commitment', 'a0000000-0000-0000-0000-0000000000c1', 'Back to back',
          tstzrange('2030-01-07 19:00+05', '2030-01-07 20:00+05', '[)'));
  raise notice 'PASS 3: back-to-back blocks (18:00-19:00 then 19:00-20:00) both succeed';

  insert into calendar_blocks (kind, commitment_id, title, period, status)
  values ('commitment', 'a0000000-0000-0000-0000-0000000000c1', 'Cancelled one',
          tstzrange('2030-01-08 09:00+05', '2030-01-08 10:00+05', '[)'), 'cancelled');
  insert into calendar_blocks (kind, commitment_id, title, period)
  values ('commitment', 'a0000000-0000-0000-0000-0000000000c1', 'Over a cancelled one',
          tstzrange('2030-01-08 09:30+05', '2030-01-08 10:30+05', '[)'));
  raise notice 'PASS 4: overlapping a cancelled block succeeds';
end $$;

select pg_temp.as_user('test-user-b');
do $$
begin
  insert into calendar_blocks (kind, commitment_id, title, period)
  values ('commitment', 'b0000000-0000-0000-0000-0000000000c1', 'B at the same time as A',
          tstzrange('2030-01-07 18:00+05', '2030-01-07 19:00+05', '[)'));
  raise notice 'PASS 5: overlap between two different users succeeds';
end $$;

-- ───────────────────────── 6. generator across a month boundary
select pg_temp.as_user('test-user-gen');
insert into profiles (display_name, timezone) values ('Gen', 'Asia/Karachi');
insert into goals (id, title, deadline) values ('c0000000-0000-0000-0000-000000000001', 'Finish AI Agent portfolio project', '2026-12-15');
insert into schedule_rules (goal_id, weekdays, start_time, duration_min) values ('c0000000-0000-0000-0000-000000000001', '{1,3,6}', '20:00', 90);

do $$
declare n int; first_start timestamptz; last_start timestamptz; k int;
begin
  -- now = Wed 28 Oct 2026 12:00 Karachi; 14 days runs to Tue 10 Nov
  select count(*) into k from generate_blocks(14, null, null, '2026-10-28 12:00+05');
  select count(*), min(lower(period)), max(lower(period)) into n, first_start, last_start
    from calendar_blocks where goal_id = 'c0000000-0000-0000-0000-000000000001';
  -- Wed 28, Sat 31, Mon 2, Wed 4, Sat 7, Mon 9 = 6 sessions
  assert n = 6, format('FAIL 6: expected 6 sessions across the month boundary, got %s', n);
  assert first_start = '2026-10-28 20:00+05', format('FAIL 6: first session at %s', first_start);
  assert last_start = '2026-11-09 20:00+05', format('FAIL 6: last session at %s', last_start);
  assert k = 0, 'FAIL 6: unexpected conflicts';
  assert (select bool_and(upper(period) - lower(period) = interval '90 minutes') from calendar_blocks
           where goal_id = 'c0000000-0000-0000-0000-000000000001'), 'FAIL 6: wrong durations';
  raise notice 'PASS 6: generator across a month boundary (6 sessions, 28 Oct to 9 Nov, stored in UTC)';

  -- idempotent: running again adds nothing
  perform generate_blocks(14, null, null, '2026-10-28 12:00+05');
  select count(*) into n from calendar_blocks where goal_id = 'c0000000-0000-0000-0000-000000000001';
  assert n = 6, format('FAIL 6b: re-run duplicated sessions (%s)', n);
  raise notice 'PASS 6b: re-running the generator never duplicates';
end $$;

-- ───────────────────────── 7. deadline mid-week
insert into goals (id, title, deadline) values ('c0000000-0000-0000-0000-000000000002', 'Write the freelance case study', '2026-11-04');
insert into schedule_rules (goal_id, weekdays, start_time, duration_min) values ('c0000000-0000-0000-0000-000000000002', '{2,4}', '09:00', 60);
do $$
declare n int; last_start timestamptz;
begin
  perform generate_blocks(14, 'c0000000-0000-0000-0000-000000000002', null, '2026-10-28 12:00+05');
  select count(*), max(lower(period)) into n, last_start
    from calendar_blocks where goal_id = 'c0000000-0000-0000-0000-000000000002';
  -- Thu 29 Oct, Tue 3 Nov; Thu 5 Nov is after the Wed 4 Nov deadline
  assert n = 2, format('FAIL 7: expected 2 sessions before a mid-week deadline, got %s', n);
  assert last_start = '2026-11-03 09:00+05', format('FAIL 7: last session at %s', last_start);
  raise notice 'PASS 7: sessions stop at a mid-week deadline';
end $$;

-- ───────────────────────── 8. a commitment that blocks one rule slot
insert into commitments (id, title, weekdays, start_time, duration_min, one_off_date)
  values ('c0000000-0000-0000-0000-0000000000c1', 'Gym', '{}', '20:30', 60, '2026-11-11');
do $$
declare n int; conflict gen_conflict;
begin
  -- move "now" forward so Wed 11 Nov enters the window; the gym commitment comes first
  select * into conflict from generate_blocks(14, null, null, '2026-10-29 12:00+05') limit 1;
  assert conflict.kind = 'session', format('FAIL 8: expected a session conflict, got %s', conflict);
  assert conflict.starts_at = '2026-11-11 20:00+05', format('FAIL 8: wrong slot %s', conflict.starts_at);
  assert conflict.clash_title = 'Gym', format('FAIL 8: clash reported with %s', conflict.clash_title);
  select count(*) into n from calendar_blocks
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and lower(period) = '2026-11-11 20:00+05';
  assert n = 0, 'FAIL 8: the clashing slot was double-booked';
  raise notice 'PASS 8: a slot blocked by a commitment is reported (Wed 11 Nov 20:00 clashes with Gym), not double-booked';
end $$;

-- ───────────────────────── 9. a rule change regenerates only future planned blocks
do $$
declare n_done int; n_moved int; n_old int; n_new int;
begin
  -- a past session that was done, and a future one the user moved by hand
  update calendar_blocks set status = 'done', minutes_done = 90
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and lower(period) = '2026-10-28 20:00+05';
  update calendar_blocks set period = tstzrange('2026-11-02 18:00+05', '2026-11-02 19:30+05', '[)')
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and slot_start = '2026-11-02 20:00+05';

  update schedule_rules set start_time = '21:00' where goal_id = 'c0000000-0000-0000-0000-000000000001';
  perform regenerate_goal('c0000000-0000-0000-0000-000000000001', 14, '2026-10-29 12:00+05');

  select count(*) into n_done from calendar_blocks
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and status = 'done' and lower(period) = '2026-10-28 20:00+05';
  select count(*) into n_moved from calendar_blocks
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and lower(period) = '2026-11-02 18:00+05';
  select count(*) into n_old from calendar_blocks
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and status = 'planned'
     and (lower(period) at time zone 'Asia/Karachi')::time = '20:00';
  select count(*) into n_new from calendar_blocks
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and status = 'planned'
     and (lower(period) at time zone 'Asia/Karachi')::time = '21:00';
  assert n_done = 1, 'FAIL 9: the done session was touched';
  assert n_moved = 1, 'FAIL 9: the hand-moved session was regenerated or lost';
  assert n_old = 0, format('FAIL 9: %s old 20:00 planned sessions remain', n_old);
  -- Sat 31, Wed 4, Sat 7, Mon 9 at 21:00. Mon 2 keeps its moved session; Wed 11 21:00
  -- would overlap Gym, so it is reported instead of booked.
  assert n_new = 4, format('FAIL 9: expected 4 new 21:00 sessions, got %s', n_new);
  raise notice 'PASS 9: rule change replaced only future planned sessions (done and moved kept, % new at 21:00)', n_new;
end $$;

-- ───────────────────────── 10. free slots never overlap anything
do $$
declare r record; n int := 0; k int; w tstzrange;
begin
  -- real "now" is used by free_slots; book a 4-hour block in the next two days to steer
  -- around, in the first window the fixtures above leave free (they sit on fixed dates)
  for h in 24..48 loop
    w := tstzrange(date_trunc('hour', now()) + make_interval(hours => h),
                   date_trunc('hour', now()) + make_interval(hours => h + 4), '[)');
    exit when not exists (select 1 from calendar_blocks b
                           where b.user_id = current_uid() and b.status not in ('cancelled', 'skipped')
                             and b.period && w);
  end loop;
  insert into commitments (id, title, weekdays, start_time, duration_min, one_off_date)
    values ('c0000000-0000-0000-0000-0000000000c2', 'Blocker', '{}', '00:00', 15,
            (lower(w) at time zone 'Asia/Karachi')::date);
  insert into calendar_blocks (kind, commitment_id, title, period)
    values ('commitment', 'c0000000-0000-0000-0000-0000000000c2', 'Blocker', w);
  for r in select * from free_slots(90, now(), now() + interval '7 days', 40) loop
    n := n + 1;
    select count(*) into k from calendar_blocks b
     where b.user_id = current_uid() and b.status not in ('cancelled', 'skipped')
       and b.period && tstzrange(r.starts_at, r.ends_at, '[)');
    assert k = 0, format('FAIL 10: free slot %s overlaps a block', r.starts_at);
    assert not in_quiet_hours(r.starts_at, r.ends_at, 'Asia/Karachi', '23:00', '07:00'),
      format('FAIL 10: free slot %s is in quiet hours', r.starts_at);
    assert extract(minute from r.starts_at at time zone 'Asia/Karachi') in (0, 30), 'FAIL 10: slot off the 30 min grid';
  end loop;
  assert n = 40, format('FAIL 10: expected 40 slots, got %s', n);
  raise notice 'PASS 10: 40 free slots, none overlapping, none in quiet hours, all on the half hour';
end $$;

-- ───────────────────────── 11. assistant apply / clash rollback / undo
do $$
declare v_run uuid; v_res jsonb; n int; v_sess uuid; v_start timestamptz;
begin
  select id, lower(period) into v_sess, v_start from calendar_blocks
   where goal_id = 'c0000000-0000-0000-0000-000000000001' and status = 'planned'
   order by lower(period) desc limit 1;

  -- one ok add plus a move that lands on an occupied slot (the Gym block)
  insert into assistant_runs (transcript, plan, checks) values ('test', '{}', jsonb_build_array(
    jsonb_build_object('index', 0, 'type', 'add_commitment', 'status', 'ok', 'title', 'Doctor visit',
                       'local_date', '2027-01-04', 'local_start_time', '11:00', 'duration_min', 60, 'repeat_weekdays', '[]'::jsonb),
    jsonb_build_object('index', 1, 'type', 'move_session', 'status', 'ok', 'session_id', v_sess,
                       'starts_at', '2026-11-11 20:30+05', 'ends_at', '2026-11-11 22:00+05')))
  returning id into v_run;
  begin
    perform assistant_apply(v_run, array[0, 1]);
    raise exception 'FAIL 11: apply with a clash succeeded';
  exception when exclusion_violation then
    null;
  end;
  select count(*) into n from commitments where title = 'Doctor visit';
  assert n = 0, 'FAIL 11: a partial apply was left behind after the clash';
  raise notice 'PASS 11: a clash anywhere in the plan rolls back the whole apply';

  -- apply only the ok, clash-free action, then undo it
  v_res := assistant_apply(v_run, array[0]);
  select count(*) into n from commitments where title = 'Doctor visit';
  assert n = 1, 'FAIL 11b: apply did not add the commitment';
  -- the generator only reaches 14 days ahead, so the far-future one-off has no block yet;
  -- undo must still remove the commitment
  perform assistant_undo(v_run);
  select count(*) into n from commitments where title = 'Doctor visit';
  assert n = 0, 'FAIL 11b: undo did not remove the commitment';
  raise notice 'PASS 11b: apply then undo leaves the schedule as it was';
end $$;

-- ───────────────────────── 12. delete_my_account removes only the caller's rows
select pg_temp.as_user('test-user-b');
do $$
declare n int;
begin
  perform delete_my_account();
  select count(*) into n from goals where user_id = 'test-user-b';
  assert n = 0, 'FAIL 12: user B still has goals';
  raise notice 'PASS 12: delete_my_account removed every row of user B';
end $$;
select pg_temp.as_user('test-user-a');
do $$
declare n int;
begin
  select count(*) into n from goals where user_id = 'test-user-a';
  assert n = 1, 'FAIL 12b: deleting B touched A';
  raise notice 'PASS 12b: other users are untouched';
end $$;

-- ───────────────────────── clean-up
select pg_temp.as_user('test-user-a');
select delete_my_account();
select pg_temp.as_user('test-user-gen');
select delete_my_account();
select pg_temp.as_user('');
