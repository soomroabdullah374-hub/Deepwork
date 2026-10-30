-- DeepWork — tests for the RPC functions the api Edge Function calls (db/api.sql).
-- Run as the API role after db_test.sql (same setup):
--   psql "$TEST_DATABASE_URL_API" -v ON_ERROR_STOP=1 -f db/tests/api_test.sql

\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"sub":"test-user-api"}', false);

do $$
declare s jsonb; r jsonb; g uuid; c uuid; n int; b jsonb; e text; d text; t timestamptz;
begin
  -- A1: first load creates the profile and returns an empty state
  s := app_state(now() - interval '7 days', now() + interval '14 days', 'Abdullah', 'Asia/Karachi');
  assert s -> 'profile' ->> 'display_name' = 'Abdullah', format('FAIL A1: %s', s -> 'profile');
  assert jsonb_array_length(s -> 'goals') = 0 and jsonb_array_length(s -> 'blocks') = 0, 'FAIL A1: not empty';
  raise notice 'PASS A1: app_state creates the profile on first load';

  -- A2: a commitment every day 14:00-17:00 is saved and booked
  r := save_commitment('{"title":"Training class","weekdays":[0,1,2,3,4,5,6],"start_time":"14:00","duration_min":180}');
  c := (r ->> 'commitment_id')::uuid;
  select count(*) into n from calendar_blocks where commitment_id = c;
  assert n between 13 and 14, format('FAIL A2: expected 13-14 occurrences, got %s', n);
  raise notice 'PASS A2: save_commitment books % occurrences', n;

  -- A3: a goal whose rhythm sits on the class clashes; it is still created, clashes reported
  r := create_goal(jsonb_build_object(
         'title', 'Finish AI Agent portfolio project', 'why', 'Ship an agent end to end',
         'deadline', (current_date + 60)::text,
         'milestones', '[{"title":"Define scope"},{"title":"Build core loop"},{"title":"Polish"}]'::jsonb,
         'rule', '{"weekdays":[1,3,6],"start_time":"16:00","duration_min":90,"lead_min":10}'::jsonb));
  g := (r ->> 'goal_id')::uuid;
  assert jsonb_array_length(r -> 'conflicts') >= 5, format('FAIL A3: expected clashes, got %s', r -> 'conflicts');
  assert (r -> 'conflicts' -> 0 ->> 'clash_title') = 'Training class', 'FAIL A3: wrong clash title';
  select count(*) into n from milestones where goal_id = g;
  assert n = 3, 'FAIL A3: milestones not saved';
  raise notice 'PASS A3: create_goal saves goal, plan and rhythm and reports % clashes', jsonb_array_length(r -> 'conflicts');

  -- A4: moving the rhythm to 20:00 clears every clash and books sessions
  r := update_rule(g, '{"start_time":"20:00"}');
  assert jsonb_array_length(r -> 'conflicts') = 0, format('FAIL A4: %s', r);
  select count(*) into n from calendar_blocks where goal_id = g and status = 'planned';
  assert n >= 5, format('FAIL A4: expected booked sessions, got %s', n);
  raise notice 'PASS A4: update_rule regenerates (% sessions, no clashes)', n;

  -- A5: a commitment on top of a session is refused with a named clash, nothing saved
  begin
    perform save_commitment('{"title":"Gym","weekdays":[1,3,6],"start_time":"20:30","duration_min":60}');
    raise exception 'FAIL A5: overlapping commitment saved';
  exception when exclusion_violation then
    get stacked diagnostics e = message_text, d = pg_exception_detail;
    assert e = 'That time is taken.', format('FAIL A5: message %s', e);
    assert (d::jsonb ->> 'title') = 'Finish AI Agent portfolio project', format('FAIL A5: detail %s', d);
  end;
  select count(*) into n from commitments where title = 'Gym';
  assert n = 0, 'FAIL A5: a clashing commitment was left behind';
  raise notice 'PASS A5: clashing commitment refused: "That time is taken." with %', d::jsonb ->> 'title';

  -- A6: check_slots reports a clash for 20:30 and none for 22:00 on a session day
  select lower(period) into t from calendar_blocks
   where goal_id = g and status = 'planned' order by lower(period) limit 1;
  r := check_slots(jsonb_build_array(
         jsonb_build_object('starts_at', t + interval '30 minutes', 'ends_at', t + interval '90 minutes'),
         jsonb_build_object('starts_at', t + interval '2 hours', 'ends_at', t + interval '3 hours')));
  assert (r -> 0 -> 'clash') is not null and jsonb_typeof(r -> 0 -> 'clash') = 'object', format('FAIL A6: %s', r);
  assert jsonb_typeof(r -> 1 -> 'clash') = 'null', format('FAIL A6: %s', r);
  raise notice 'PASS A6: check_slots flags the overlapping slot only';

  -- A7: session actions: start → finish, snooze into a clash is refused, move works
  select block_json(x) into b from calendar_blocks x where goal_id = g and status = 'planned' order by lower(period) limit 1;
  r := block_action((b ->> 'id')::uuid, 'start');
  assert r ->> 'status' = 'in_progress', 'FAIL A7: start';
  r := block_action((b ->> 'id')::uuid, 'finish', '{"minutes":85}');
  assert r ->> 'status' = 'done' and (r ->> 'minutes_done')::int = 85, format('FAIL A7: finish %s', r);

  -- put a commitment right after the next session, then snooze into it
  select block_json(x) into b from calendar_blocks x where goal_id = g and status = 'planned' order by lower(period) limit 1;
  r := save_commitment(jsonb_build_object('title', 'Call', 'weekdays', '[]'::jsonb,
         'one_off_date', ((b ->> 'ends_at')::timestamptz at time zone 'Asia/Karachi')::date,
         'start_time', to_char((b ->> 'ends_at')::timestamptz at time zone 'Asia/Karachi', 'HH24:MI'),
         'duration_min', 30));
  begin
    perform block_action((b ->> 'id')::uuid, 'snooze');
    raise exception 'FAIL A7: snooze into a clash succeeded';
  exception when exclusion_violation then
    get stacked diagnostics d = pg_exception_detail;
    assert d::jsonb ->> 'title' = 'Call', format('FAIL A7: snooze clash detail %s', d);
  end;
  r := block_action((b ->> 'id')::uuid, 'move', jsonb_build_object('starts_at', (b ->> 'starts_at')::timestamptz - interval '2 hours'));
  assert (r ->> 'starts_at')::timestamptz = (b ->> 'starts_at')::timestamptz - interval '2 hours', format('FAIL A7: move %s', r);
  begin
    perform block_action((b ->> 'id')::uuid, 'move', jsonb_build_object('starts_at', now() - interval '1 day'));
    raise exception 'FAIL A7: move into the past succeeded';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS A7: start, finish, snooze clash ("%"), move, and past moves refused', d::jsonb ->> 'title';

  -- A8: plan edits keep done state and order
  r := replace_milestones(g, (select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'done', position = 0) order by position desc)
                                from milestones where goal_id = g));
  assert r -> 0 ->> 'title' = 'Polish' and (r -> 2 ->> 'done_at') is not null, format('FAIL A8: %s', r);
  r := set_milestone_done((r -> 0 ->> 'id')::uuid, true);
  assert r ->> 'done_at' is not null, 'FAIL A8: toggle';
  raise notice 'PASS A8: replace_milestones reorders and keeps done state';

  -- A9: a new time zone shifts future generated sessions to the same local time
  r := update_profile('{"timezone":"Asia/Dubai"}');
  select count(*) into n from calendar_blocks
   where goal_id = g and status = 'planned' and lower(period) > now()
     and created_by = 'generator' and lower(period) = slot_start   -- hand-moved ones stay put
     and (lower(period) at time zone 'Asia/Dubai')::time <> '20:00';
  assert n = 0, format('FAIL A9: %s sessions not at 20:00 Dubai time', n);
  begin
    perform update_profile('{"timezone":"Mars/Base"}');
    raise exception 'FAIL A9: bad time zone accepted';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS A9: time zone change regenerates sessions at the same local time';

  -- A10: device registration and full state round trip
  r := register_device('token-api-test-0000000000', 'android');
  s := app_state(now() - interval '7 days', now() + interval '14 days');
  assert jsonb_array_length(s -> 'goals') = 1 and jsonb_array_length(s -> 'commitments') = 2, format('FAIL A10: %s', s -> 'goals');
  assert (s -> 'goals' -> 0 ->> 'sessions_done')::int = 1, 'FAIL A10: sessions_done';
  raise notice 'PASS A10: app_state returns goals with plan and progress, commitments and blocks';

  -- A11: apply runs cancels before adds, so an add may take the time a cancel frees
  declare
    v_sess calendar_blocks;
    v_run  uuid;
  begin
    select * into v_sess from calendar_blocks
     where goal_id = g and status = 'planned' and lower(period) > now() + interval '1 hour'
     order by lower(period) limit 1;
    insert into assistant_runs (transcript, plan, checks) values ('swap', '{}', jsonb_build_array(
      jsonb_build_object('index', 0, 'type', 'add_session', 'status', 'ok', 'goal_id', g,
                         'starts_at', lower(v_sess.period), 'ends_at', upper(v_sess.period)),
      jsonb_build_object('index', 1, 'type', 'cancel_session', 'status', 'ok', 'session_id', v_sess.id)))
    returning id into v_run;
    r := assistant_apply(v_run, array[0, 1]);
    assert jsonb_array_length(r -> 'applied') = 2, format('FAIL A11: %s', r);
    select count(*) into n from calendar_blocks
     where goal_id = g and created_by = 'assistant' and period = v_sess.period and status = 'planned';
    assert n = 1, 'FAIL A11: the added session is missing';
    perform assistant_undo(v_run);
    select count(*) into n from calendar_blocks where id = v_sess.id and status = 'planned';
    assert n = 1, 'FAIL A11: undo did not restore the cancelled session';
    select count(*) into n from calendar_blocks where goal_id = g and created_by = 'assistant';
    assert n = 0, 'FAIL A11: undo left the added session behind';
    raise notice 'PASS A11: apply frees time before adding, and undo restores both';
  end;

  perform delete_my_account();
end $$;
