-- DeepWork — tests for the cron dispatcher's functions.
-- Fixtures are written by the API role; the checks then run as the dispatcher role:
--   psql "$TEST_DATABASE_URL_API"        -v ON_ERROR_STOP=1 -f db/tests/worker_fixtures.sql
--   psql "$TEST_DATABASE_URL_DISPATCHER" -v ON_ERROR_STOP=1 -f db/tests/worker_test.sql

\set ON_ERROR_STOP on

do $$
declare n int;
begin
  -- the dispatcher cannot read user tables directly
  begin
    select count(*) into n from calendar_blocks;
    raise exception 'FAIL W1: dispatcher read calendar_blocks directly';
  exception when insufficient_privilege then
    raise notice 'PASS W1: dispatcher has no direct access to user tables';
  end;
end $$;

do $$
declare r jsonb;
begin
  r := worker_mark_missed();
  assert (r ->> 'missed')::int >= 1, format('FAIL W2: expected a missed session, got %s', r);
  assert (r ->> 'closed')::int >= 1, format('FAIL W2: expected a stale running session to close, got %s', r);
  raise notice 'PASS W2: worker_mark_missed %', r;
end $$;

do $$
declare r jsonb;
begin
  r := worker_extend_horizon();
  assert (r ->> 'users')::int >= 1, format('FAIL W3: %s', r);
  raise notice 'PASS W3: worker_extend_horizon %', r;
end $$;

do $$
declare n int; g int; k int; ids bigint[];
begin
  select count(*), count(goal_id), array_agg(job_id) into n, g, ids from worker_claim_pushes() where kind in ('lead', 'start');
  assert n >= 1, 'FAIL W4: no due lead/start push was claimed';
  assert g = n, 'FAIL W4: a session push came without its goal id';
  select count(*) into k from worker_claim_pushes() where kind in ('lead', 'start');
  assert k = 0, 'FAIL W4: the same push was claimed twice';
  perform worker_finish_pushes(ids, '{}', array['token-worker-test-bad-0000']);
  raise notice 'PASS W4: % due push(es) claimed once, marked sent, bad token removed', n;
end $$;
