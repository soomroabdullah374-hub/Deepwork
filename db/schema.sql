-- DeepWork — Neon Postgres schema with Row Level Security.
--
-- Auth: Neon Auth (Managed Better Auth). The API functions verify the user's JWT
-- against Neon Auth's JWKS, then run each request in one transaction that first sets
-- request.jwt.claims. auth.user_id() (from Neon's pg_session_jwt) reads the `sub`
-- claim from there, so every policy below resolves to the signed-in user.
--
-- The API connects as a login role that is a member of `authenticated` and has no
-- BYPASSRLS (see roles.sql.example). The table owner is only used for migrations.

-- ───────────────────────── extensions
create extension if not exists btree_gist;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_session_jwt') then
    create extension if not exists pg_session_jwt;
  else
    -- Local test databases without pg_session_jwt get the same fallback behaviour:
    -- the claims come from request.jwt.claims.
    create schema if not exists auth;
    create or replace function auth.session() returns jsonb
      language sql stable
      as 'select coalesce(nullif(current_setting(''request.jwt.claims'', true), ''''), ''{}'')::jsonb';
    create or replace function auth.user_id() returns text
      language sql stable
      as 'select auth.session() ->> ''sub''';
  end if;
end $$;

-- ───────────────────────── roles
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dispatcher') then
    create role dispatcher nologin;
  end if;
end $$;

grant usage on schema public to authenticated, dispatcher;
grant usage on schema auth to authenticated, dispatcher;

-- ───────────────────────── helpers
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────── profiles
create table profiles (
  user_id               text primary key default auth.user_id(),
  display_name          text not null default '' check (char_length(display_name) <= 80),
  timezone              text not null default 'Asia/Karachi',
  language              text not null default 'en' check (language in ('en', 'ur-Latn')),
  quiet_start           time not null default '23:00',
  quiet_end             time not null default '07:00',
  briefing_at           time default '07:30',            -- null turns the briefing off
  theme                 text not null default 'auto' check (theme in ('light', 'dark', 'auto')),
  notifications_enabled boolean not null default true,
  hide_titles           boolean not null default false,  -- generic text on the lock screen
  speak_replies         boolean not null default true,
  assistant_auto_apply  boolean not null default false,
  onboarded_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger profiles_touch before update on profiles
  for each row execute function touch_updated_at();

-- ───────────────────────── goals and plan
create table goals (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null default auth.user_id(),
  title      text not null check (char_length(title) between 3 and 80),
  why        text check (char_length(why) <= 500),
  deadline   date not null,
  status     text not null default 'active' check (status in ('active', 'paused', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index goals_user_status on goals (user_id, status);
create trigger goals_touch before update on goals
  for each row execute function touch_updated_at();

create table milestones (
  id       uuid primary key default gen_random_uuid(),
  user_id  text not null default auth.user_id(),
  goal_id  uuid not null,
  position int  not null check (position >= 0),
  title    text not null check (char_length(title) between 1 and 120),
  done_at  timestamptz,
  foreign key (goal_id, user_id) references goals (id, user_id) on delete cascade,
  constraint milestones_goal_position unique (goal_id, position) deferrable initially deferred
);

create table schedule_rules (
  goal_id      uuid primary key,
  user_id      text not null default auth.user_id(),
  weekdays     smallint[] not null check (cardinality(weekdays) between 1 and 7
                                          and weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),  -- 0=Sun..6=Sat
  start_time   time not null,
  duration_min int  not null check (duration_min between 15 and 240),
  lead_min     int  not null default 10 check (lead_min between 0 and 120),
  foreign key (goal_id, user_id) references goals (id, user_id) on delete cascade
);

-- ───────────────────────── commitments (fixed blocks the user adds: class, gym, work)
create table commitments (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null default auth.user_id(),
  title        text not null check (char_length(title) between 1 and 80),
  weekdays     smallint[] not null default '{}' check (weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
  start_time   time not null,
  duration_min int  not null check (duration_min between 15 and 720),
  one_off_date date,                 -- set for a single occurrence instead of weekly
  starts_on    date,                 -- weekly series begin on this date (inclusive)
  created_by   text not null default 'app' check (created_by in ('app', 'assistant')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, user_id),
  check (one_off_date is not null or cardinality(weekdays) between 1 and 7)
);
create trigger commitments_touch before update on commitments
  for each row execute function touch_updated_at();

-- ───────────────────────── THE no-overlap table
-- Every concrete block on the calendar: generated sessions AND expanded commitment occurrences.
create table calendar_blocks (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null default auth.user_id(),
  kind          text not null check (kind in ('session', 'commitment')),
  goal_id       uuid,
  commitment_id uuid,
  title         text not null,
  period        tstzrange not null check (not isempty(period) and lower_inc(period) and not upper_inc(period)
                                          and not lower_inf(period) and not upper_inf(period)),
  slot_start    timestamptz,         -- the rule/commitment slot this block was generated for; kept when moved
  status        text not null default 'planned'
                check (status in ('planned', 'in_progress', 'done', 'skipped', 'missed', 'snoozed', 'cancelled')),
  minutes_done  int check (minutes_done between 0 and 1440),
  note          text check (char_length(note) <= 280),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_by    text not null default 'app' check (created_by in ('app', 'generator', 'assistant')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (goal_id, user_id) references goals (id, user_id) on delete cascade,
  foreign key (commitment_id, user_id) references commitments (id, user_id) on delete cascade,
  check ((kind = 'session' and goal_id is not null and commitment_id is null)
      or (kind = 'commitment' and commitment_id is not null and goal_id is null)),
  -- Nothing may appear twice at one time: no two live blocks of one user may overlap.
  -- '[)' ranges let 18:00–19:00 and 19:00–20:00 sit back to back.
  constraint no_overlap exclude using gist (user_id with =, period with &&)
    where (status not in ('cancelled', 'skipped'))
);
create index calendar_blocks_user_start on calendar_blocks (user_id, lower(period));
create unique index calendar_blocks_goal_slot on calendar_blocks (goal_id, slot_start)
  where goal_id is not null and slot_start is not null;
create unique index calendar_blocks_commitment_slot on calendar_blocks (commitment_id, slot_start)
  where commitment_id is not null and slot_start is not null;
create trigger calendar_blocks_touch before update on calendar_blocks
  for each row execute function touch_updated_at();

-- Keep the denormalised block titles in step with their goal or commitment.
create or replace function sync_block_titles() returns trigger
language plpgsql as $$
begin
  if new.title is distinct from old.title then
    if tg_table_name = 'goals' then
      update calendar_blocks set title = new.title where goal_id = new.id;
    else
      update calendar_blocks set title = new.title where commitment_id = new.id;
    end if;
  end if;
  return new;
end $$;
create trigger goals_sync_titles after update of title on goals
  for each row execute function sync_block_titles();
create trigger commitments_sync_titles after update of title on commitments
  for each row execute function sync_block_titles();

-- ───────────────────────── devices and notifications
create table devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default auth.user_id(),
  fcm_token   text not null unique check (char_length(fcm_token) between 20 and 4096),
  platform    text not null check (platform in ('ios', 'android')),
  updated_at  timestamptz not null default now()
);
create index devices_user on devices (user_id);

-- Sent log for server push (FCM). `ref` is the block id, or goal id + date for deadline
-- and briefing pushes. The unique key stops two cron ticks from sending the same push.
create table notification_jobs (
  id          bigserial primary key,
  user_id     text not null,
  block_id    uuid references calendar_blocks (id) on delete cascade,
  kind        text not null check (kind in ('lead', 'start', 'missed', 'deadline', 'briefing')),
  ref         text not null,
  due_at      timestamptz not null,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  attempts    int not null default 0,
  last_error  text,
  unique (user_id, kind, ref)
);
create index notification_jobs_due on notification_jobs (due_at) where sent_at is null;

-- ───────────────────────── assistant audit + undo
create table assistant_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null default auth.user_id(),
  transcript    text not null check (char_length(transcript) <= 2000),
  language      text,
  plan          jsonb not null,
  checks        jsonb not null,
  applied_at    timestamptz,
  undo_until    timestamptz,
  undo_payload  jsonb,
  undone_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index assistant_runs_user_created on assistant_runs (user_id, created_at desc);

-- ───────────────────────── RLS: every table, enabled and forced
do $$
declare t text;
begin
  foreach t in array array['profiles', 'goals', 'milestones', 'schedule_rules', 'commitments',
                           'calendar_blocks', 'devices', 'notification_jobs', 'assistant_runs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
  foreach t in array array['profiles', 'goals', 'milestones', 'schedule_rules', 'commitments',
                           'calendar_blocks', 'devices', 'assistant_runs']
  loop
    execute format($p$create policy own_rows on %I for all to authenticated
                      using (user_id = auth.user_id())
                      with check (user_id = auth.user_id())$p$, t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Users may read (not write) their own push log; only the dispatcher's definer
-- functions write it.
create policy own_rows_read on notification_jobs for select to authenticated
  using (user_id = auth.user_id());
grant select on notification_jobs to authenticated;
