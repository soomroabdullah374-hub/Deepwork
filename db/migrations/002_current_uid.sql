-- Neon's Data API reinstalls pg_session_jwt under a platform-owned `auth` schema that the
-- `authenticated` role cannot use. Route policies and defaults through current_uid(), an
-- owner-run wrapper around auth.user_id(). (Fresh installs get this from schema.sql.)

create or replace function current_uid() returns text
language sql stable security definer set search_path = public, pg_temp
as $$ select auth.user_id() $$;
revoke all on function current_uid() from public;
grant execute on function current_uid() to authenticated, dispatcher;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'goals', 'milestones', 'schedule_rules', 'commitments',
                           'calendar_blocks', 'devices', 'assistant_runs']
  loop
    execute format('alter table %I alter column user_id set default current_uid()', t);
    execute format('drop policy if exists own_rows on %I', t);
    execute format($p$create policy own_rows on %I for all to authenticated
                      using (user_id = (select current_uid()))
                      with check (user_id = (select current_uid()))$p$, t);
  end loop;
end $$;

drop policy if exists own_rows_read on notification_jobs;
create policy own_rows_read on notification_jobs for select to authenticated
  using (user_id = (select current_uid()));
