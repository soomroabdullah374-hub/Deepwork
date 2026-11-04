-- Reminder call with real audio, against the deployed API. Run it in the Supabase SQL
-- editor: it uses the `http` extension, so the requests go over the internet like the
-- app's. The clips are fetched from this repository (audio/README.md says what each says)
-- and sent base64 exactly as the call screen sends its recordings.
--
-- A throwaway user (random password) gets a session about 35 minutes away; the call runs
-- in English, then in Roman Urdu; the account is deleted at the end. Tokens never leave
-- the function: the result only says what each step heard, said and saved.

create or replace function pg_temp.j(p text) returns jsonb language plpgsql immutable as $$
begin return p::jsonb; exception when others then return null; end $$;

create or replace function pg_temp.call(p_method text, p_url text, p_jwt text, p_body jsonb default null)
returns extensions.http_response language sql as $$
  select extensions.http((p_method, p_url,
    array[extensions.http_header('Authorization', 'Bearer ' || p_jwt), extensions.http_header('x-timezone', 'Asia/Karachi')],
    case when p_body is null then null else 'application/json' end,
    case when p_body is null then null else p_body::text end)::extensions.http_request)
$$;

-- a clip from the repository, base64 (the GitHub contents API returns it that way)
create or replace function pg_temp.clip(p_name text) returns text language plpgsql as $$
declare r extensions.http_response;
begin
  r := extensions.http(('GET', 'https://api.github.com/repos/soomroabdullah374-hub/Deepwork/contents/supabase/tests/audio/'
                        || p_name || '?ref=claude/brave-knuth-k1s82l',
                        array[extensions.http_header('User-Agent', 'deepwork-call-e2e'),
                              extensions.http_header('Accept', 'application/vnd.github+json')],
                        null, null)::extensions.http_request);
  return replace(pg_temp.j(r.content) ->> 'content', E'\n', '');
end $$;

create or replace function pg_temp.turn(p_jwt text, p_block text, p_hist jsonb, p_audio text default null)
returns jsonb language plpgsql as $$
declare r extensions.http_response; t0 timestamptz := clock_timestamp();
begin
  r := pg_temp.call('POST', 'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/api/call/turn', p_jwt,
         jsonb_strip_nulls(jsonb_build_object('block_id', p_block, 'history', p_hist, 'audio', p_audio,
                                              'mime', case when p_audio is null then null else 'audio/mp4' end)));
  return coalesce(pg_temp.j(r.content), jsonb_build_object('raw', left(r.content, 200)))
         || jsonb_build_object('_status', r.status, '_ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int);
end $$;

create or replace function pg_temp.voicetest()
returns table (step text, ok boolean, ms int, info text)
language plpgsql as $$
declare
  v_api    text := 'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/api';
  v_email  text := 'voice-' || encode(extensions.gen_random_bytes(5), 'hex') || '@example.com';
  v_pw     text := encode(extensions.gen_random_bytes(18), 'hex');
  v_local  timestamp := now() at time zone 'Asia/Karachi';
  v_start  text;
  v_jwt    text;
  r        extensions.http_response;
  b        jsonb;
  v_goal   text;
  v_block  text;
  v_before timestamptz;
  v_after  timestamptz;
  v_hist   jsonb := '[]'::jsonb;
  v_en     text := pg_temp.clip('call_later_en.m4a');
  v_ur     text := pg_temp.clip('call_later_ur.m4a');
  v_quiet  text := pg_temp.clip('call_silence.m4a');
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000');
  step := 'clips from the repository'; ok := length(v_en) > 1000 and length(v_ur) > 1000 and length(v_quiet) > 500;
  info := format('%s, %s and %s base64 chars', length(v_en), length(v_ur), length(v_quiet)); return next;
  if not ok then return; end if;

  v_start := to_char(date_trunc('hour', v_local)
                     + make_interval(mins => (ceil((extract(minute from v_local) + 35) / 5) * 5)::int), 'HH24:MI');
  r := extensions.http(('POST', v_api || '/auth/sign-up', array[]::extensions.http_header[], 'application/json',
         jsonb_build_object('email', v_email, 'password', v_pw, 'name', 'Sara')::text)::extensions.http_request);
  v_jwt := pg_temp.j(r.content) ->> 'jwt';
  step := 'sign up'; ok := r.status = 201 and v_jwt is not null; info := r.status::text; return next;
  if v_jwt is null then return; end if;

  begin
    r := pg_temp.call('GET', v_api || '/state', v_jwt);
    r := pg_temp.call('PATCH', v_api || '/profile', v_jwt, '{"language":"en"}');
    r := pg_temp.call('POST', v_api || '/goals', v_jwt, jsonb_build_object(
           'title', 'Thesis writing', 'deadline', (v_local::date + 30)::text,
           'rule', jsonb_build_object('weekdays', jsonb_build_array(0, 1, 2, 3, 4, 5, 6), 'start_time', v_start,
                                      'duration_min', 45, 'lead_min', 30, 'call_lead_min', 10)));
    v_goal := pg_temp.j(r.content) ->> 'goal_id';
    r := pg_temp.call('GET', v_api || '/state', v_jwt);
    select x ->> 'id', (x ->> 'starts_at')::timestamptz into v_block, v_before from jsonb_array_elements(pg_temp.j(r.content) -> 'blocks') x
     where x ->> 'kind' = 'session' and x ->> 'status' = 'planned' and (x ->> 'starts_at')::timestamptz > now()
     order by (x ->> 'starts_at')::timestamptz limit 1;
    step := 'setup: English, session soon, call 10 min before'; ok := v_block is not null;
    info := 'session ' || to_char(v_before at time zone 'Asia/Karachi', 'Dy HH24:MI'); return next;

    b := pg_temp.turn(v_jwt, v_block, v_hist);
    step := '1 opens in English'; ms := (b ->> '_ms')::int;
    ok := (b ->> '_status')::int = 200 and b -> 'reply' ->> 'language' = 'en' and b -> 'reply' ->> 'text' ilike '%thesis%';
    info := b -> 'reply' ->> 'text'; return next;
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));

    b := pg_temp.turn(v_jwt, v_block, v_hist, v_en);
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'user', 'text', b ->> 'heard'), jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));
    r := pg_temp.call('GET', v_api || '/blocks?goal=' || v_goal, v_jwt);
    select (x ->> 'starts_at')::timestamptz into v_after from jsonb_array_elements(pg_temp.j(r.content)) x where x ->> 'id' = v_block;
    step := '2 voice: "Can we do it ten minutes later?"'; ms := (b ->> '_ms')::int;
    ok := b ->> 'heard' ~* '(ten|10) minutes' and b -> 'action' ->> 'type' = 'snooze' and (b ->> 'changed')::boolean
          and v_after = v_before + interval '10 minutes';
    info := format('heard "%s" → %s [%s] | plan %s → %s', b ->> 'heard', b -> 'reply' ->> 'text', b -> 'action' ->> 'type',
                   to_char(v_before at time zone 'Asia/Karachi', 'HH24:MI'), to_char(v_after at time zone 'Asia/Karachi', 'HH24:MI'));
    return next;

    b := pg_temp.turn(v_jwt, v_block, v_hist, v_quiet);
    step := '3 voice: silence'; ms := (b ->> '_ms')::int;
    ok := (b ->> 'silent')::boolean and b ->> 'heard' = '';
    info := left(b::text, 160); return next;

    r := pg_temp.call('PATCH', v_api || '/profile', v_jwt, '{"language":"ur-Latn"}');
    v_before := v_after;
    b := pg_temp.turn(v_jwt, v_block, v_hist, v_ur);
    r := pg_temp.call('GET', v_api || '/blocks?goal=' || v_goal, v_jwt);
    select (x ->> 'starts_at')::timestamptz into v_after from jsonb_array_elements(pg_temp.j(r.content)) x where x ->> 'id' = v_block;
    step := '4 voice, Urdu: "دس منٹ بعد کروں گا"'; ms := (b ->> '_ms')::int;
    ok := length(b ->> 'heard') > 3 and b -> 'reply' ->> 'language' = 'ur-Latn' and b -> 'action' ->> 'type' = 'snooze'
          and (b ->> 'changed')::boolean and v_after = v_before + interval '10 minutes';
    info := format('heard "%s" → %s [%s] | plan %s → %s', b ->> 'heard', b -> 'reply' ->> 'text', b -> 'action' ->> 'type',
                   to_char(v_before at time zone 'Asia/Karachi', 'HH24:MI'), to_char(v_after at time zone 'Asia/Karachi', 'HH24:MI'));
    return next;
  exception when others then
    step := 'error'; ok := false; info := sqlerrm; return next;
  end;

  r := pg_temp.call('DELETE', v_api || '/account', v_jwt);
  step := 'delete test account'; ms := null; ok := r.status = 200; info := left(r.content, 60); return next;
end $$;

select step, ok, ms, info from pg_temp.voicetest();
