-- Fixtures for worker_test.sql, written by the API role as a normal user would.
\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"sub":"test-user-worker"}', false);
insert into profiles (display_name, timezone, quiet_start, quiet_end)
  values ('Worker test', 'UTC', '00:00', '00:00');   -- no quiet hours so the test is time-independent
insert into goals (id, title, deadline)
  values ('d0000000-0000-0000-0000-000000000001', 'Worker goal', current_date + 30);
insert into schedule_rules (goal_id, weekdays, start_time, duration_min, lead_min)
  values ('d0000000-0000-0000-0000-000000000001', '{0,1,2,3,4,5,6}', '00:00', 60, 15);
-- a session that ended an hour ago and never started  → missed
insert into calendar_blocks (kind, goal_id, title, period)
  values ('session', 'd0000000-0000-0000-0000-000000000001', 'Worker goal',
          tstzrange(now() - interval '3 hours', now() - interval '2 hours', '[)'));
-- a session left running 7 hours past its end → closed as done
insert into calendar_blocks (kind, goal_id, title, period, status, started_at)
  values ('session', 'd0000000-0000-0000-0000-000000000001', 'Worker goal',
          tstzrange(now() - interval '9 hours', now() - interval '8 hours', '[)'), 'in_progress', now() - interval '9 hours');
-- a session starting in 5 minutes → its 15-minute lead reminder is due now
insert into calendar_blocks (kind, goal_id, title, period)
  values ('session', 'd0000000-0000-0000-0000-000000000001', 'Worker goal',
          tstzrange(now() + interval '5 minutes', now() + interval '65 minutes', '[)'));
insert into devices (fcm_token, platform) values ('token-worker-test-bad-0000', 'android');
