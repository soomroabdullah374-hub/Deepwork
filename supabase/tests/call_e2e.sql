-- Reminder call in Roman Urdu, against the deployed API. Run it in the Supabase SQL
-- editor: it uses the `http` extension, so the requests go over the internet like the
-- app's (the turns here are typed; call_voice_e2e.sql sends recordings).
--
-- A throwaway user (random password) gets a daily session about 35 minutes away with a
-- 30-minute nudge and a call 10 minutes before. Then a whole call: DeepWork opens, they
-- want ten minutes, ask for gym tomorrow at 7 (asked first, saved on "haan"), try to move
-- the session onto the gym (refused, with free times either side), take 8 pm, and say
-- bye. Every change is checked in the plan afterwards; the account is deleted at the end.

create or replace function pg_temp.j(p text) returns jsonb language plpgsql immutable as $$
begin return p::jsonb; exception when others then return null; end $$;

create or replace function pg_temp.call(p_method text, p_url text, p_jwt text, p_body jsonb default null)
returns extensions.http_response language sql as $$
  select extensions.http((p_method, p_url,
    array[extensions.http_header('Authorization', 'Bearer ' || p_jwt), extensions.http_header('x-timezone', 'Asia/Karachi')],
    case when p_body is null then null else 'application/json' end,
    case when p_body is null then null else p_body::text end)::extensions.http_request)
$$;

create or replace function pg_temp.turn(p_jwt text, p_block text, p_hist jsonb, p_said text default null)
returns jsonb language plpgsql as $$
declare r extensions.http_response; t0 timestamptz := clock_timestamp();
begin
  r := pg_temp.call('POST', 'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/api/call/turn', p_jwt,
         jsonb_strip_nulls(jsonb_build_object('block_id', p_block, 'history', p_hist, 'said', p_said)));
  return coalesce(pg_temp.j(r.content), jsonb_build_object('raw', left(r.content, 200)))
         || jsonb_build_object('_status', r.status, '_ms', (extract(epoch from clock_timestamp() - t0) * 1000)::int);
end $$;

create or replace function pg_temp.said(b jsonb) returns text language sql as $$
  select format('%s [%s%s%s%s]', b -> 'reply' ->> 'text', b -> 'action' ->> 'type',
                case when b -> 'action' ->> 'time' is not null then ' ' || coalesce(b -> 'action' ->> 'date', '') || ' ' || (b -> 'action' ->> 'time') else '' end,
                case when (b ->> 'changed')::boolean then ', saved' else '' end,
                case when (b ->> 'end_call')::boolean then ', hangs up' else '' end)
$$;

create or replace function pg_temp.calltest()
returns table (step text, ok boolean, ms int, info text)
language plpgsql as $$
declare
  v_api    text := 'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/api';
  v_email  text := 'call-' || encode(extensions.gen_random_bytes(5), 'hex') || '@example.com';
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
  v_now    timestamptz;
  v_status text;
  v_gym    text;
  v_hist   jsonb := '[]'::jsonb;
  v_said   text;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000');
  v_start := to_char(date_trunc('hour', v_local)
                     + make_interval(mins => (ceil((extract(minute from v_local) + 35) / 5) * 5)::int), 'HH24:MI');

  r := extensions.http(('POST', v_api || '/auth/sign-up', array[]::extensions.http_header[], 'application/json',
         jsonb_build_object('email', v_email, 'password', v_pw, 'name', 'Abdullah')::text)::extensions.http_request);
  v_jwt := pg_temp.j(r.content) ->> 'jwt';
  step := 'sign up'; ok := r.status = 201 and v_jwt is not null; info := r.status::text; return next;
  if v_jwt is null then return; end if;

  begin
    r := pg_temp.call('GET', v_api || '/state', v_jwt);
    r := pg_temp.call('PATCH', v_api || '/profile', v_jwt, '{"language":"ur-Latn"}');
    step := 'Roman Urdu on'; ok := pg_temp.j(r.content) ->> 'language' = 'ur-Latn'; info := r.status::text; return next;

    r := pg_temp.call('POST', v_api || '/goals', v_jwt, jsonb_build_object(
           'title', 'Cloud Data Engineering labs', 'why', 'Get the certificate',
           'deadline', (v_local::date + 30)::text,
           'rule', jsonb_build_object('weekdays', jsonb_build_array(0, 1, 2, 3, 4, 5, 6), 'start_time', v_start,
                                      'duration_min', 60, 'lead_min', 30, 'call_lead_min', 10)));
    v_goal := pg_temp.j(r.content) ->> 'goal_id';
    step := 'goal: nudge 30 min, call 10 min before'; ok := r.status = 201 and v_goal is not null;
    info := 'daily at ' || v_start; return next;

    r := pg_temp.call('GET', v_api || '/state', v_jwt);
    b := pg_temp.j(r.content);
    step := 'timings come back to the app';
    ok := (b -> 'goals' -> 0 -> 'rule' ->> 'lead_min')::int = 30 and (b -> 'goals' -> 0 -> 'rule' ->> 'call_lead_min')::int = 10;
    info := format('lead_min=%s call_lead_min=%s', b -> 'goals' -> 0 -> 'rule' ->> 'lead_min', b -> 'goals' -> 0 -> 'rule' ->> 'call_lead_min');
    return next;

    select x ->> 'id', (x ->> 'starts_at')::timestamptz into v_block, v_before from jsonb_array_elements(b -> 'blocks') x
     where x ->> 'kind' = 'session' and x ->> 'status' = 'planned' and (x ->> 'starts_at')::timestamptz > now()
     order by (x ->> 'starts_at')::timestamptz limit 1;
    step := 'next session'; ok := v_block is not null;
    info := format('%s, in %s min', to_char(v_before at time zone 'Asia/Karachi', 'Dy HH24:MI'),
                   round(extract(epoch from v_before - now()) / 60)); return next;

    r := pg_temp.call('PUT', v_api || '/goals/' || v_goal || '/rule', v_jwt, jsonb_build_object(
           'weekdays', jsonb_build_array(0, 1, 2, 3, 4, 5, 6), 'start_time', v_start, 'duration_min', 60,
           'lead_min', 30, 'call_lead_min', 121));
    step := 'a call over 2 hours early is refused'; ok := r.status = 400; info := pg_temp.j(r.content) -> 'error' ->> 'message'; return next;

    b := pg_temp.turn(v_jwt, v_block, v_hist);
    step := '1 DeepWork opens'; ms := (b ->> '_ms')::int;
    ok := (b ->> '_status')::int = 200 and length(b -> 'reply' ->> 'text') > 10 and b -> 'reply' ->> 'language' = 'ur-Latn'
          and not (b ->> 'end_call')::boolean and length(b -> 'reply' ->> 'voice') > 0;
    info := pg_temp.said(b) || ' | voice: ' || (b -> 'reply' ->> 'voice'); return next;
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));

    v_said := 'Abhi thora kaam hai, das minute baad karta hoon';
    b := pg_temp.turn(v_jwt, v_block, v_hist, v_said);
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'user', 'text', v_said), jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));
    r := pg_temp.call('GET', v_api || '/blocks?goal=' || v_goal, v_jwt);
    select (x ->> 'starts_at')::timestamptz, x ->> 'status' into v_after, v_status from jsonb_array_elements(pg_temp.j(r.content)) x where x ->> 'id' = v_block;
    step := '2 "' || v_said || '"'; ms := (b ->> '_ms')::int;
    ok := b -> 'action' ->> 'type' = 'snooze' and (b ->> 'changed')::boolean and v_after = v_before + interval '10 minutes' and v_status = 'snoozed';
    info := pg_temp.said(b) || format(' | plan: %s → %s %s', to_char(v_before at time zone 'Asia/Karachi', 'HH24:MI'),
                                      to_char(v_after at time zone 'Asia/Karachi', 'HH24:MI'), v_status); return next;

    v_said := 'Aur haan, kal shaam saat baje gym bhi add kar do, ek ghante ke liye';
    b := pg_temp.turn(v_jwt, v_block, v_hist, v_said);
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'user', 'text', v_said), jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));
    step := '3 "' || v_said || '"'; ms := (b ->> '_ms')::int;
    ok := not coalesce((b ->> 'changed')::boolean, false) and b -> 'reply' ->> 'text' like '%?%';
    info := pg_temp.said(b); return next;

    v_said := 'Haan kar do';
    b := pg_temp.turn(v_jwt, v_block, v_hist, v_said);
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'user', 'text', v_said), jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));
    r := pg_temp.call('GET', v_api || '/blocks?from=' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                      || '&to=' || to_char(now() + interval '3 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_jwt);
    select format('%s %s–%s (%s)', x ->> 'title', to_char((x ->> 'starts_at')::timestamptz at time zone 'Asia/Karachi', 'Dy DD Mon HH24:MI'),
                  to_char((x ->> 'ends_at')::timestamptz at time zone 'Asia/Karachi', 'HH24:MI'), x ->> 'kind')
      into v_gym from jsonb_array_elements(pg_temp.j(r.content)) x where x ->> 'title' ilike '%gym%' limit 1;
    step := '4 "' || v_said || '"'; ms := (b ->> '_ms')::int;
    ok := (b ->> 'changed')::boolean and v_gym like '%' || to_char(v_local::date + 1, 'DD Mon') || ' 19:00–20:00%';
    info := pg_temp.said(b) || ' | plan: ' || coalesce(v_gym, 'no gym found'); return next;

    v_said := 'Acha, aaj wala session bhi kal shaam saat baje kar do';
    b := pg_temp.turn(v_jwt, v_block, v_hist, v_said);
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'user', 'text', v_said), jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));
    r := pg_temp.call('GET', v_api || '/blocks?goal=' || v_goal, v_jwt);
    select (x ->> 'starts_at')::timestamptz into v_now from jsonb_array_elements(pg_temp.j(r.content)) x where x ->> 'id' = v_block;
    step := '5 "' || v_said || '" (gym is there)'; ms := (b ->> '_ms')::int;
    ok := not coalesce((b ->> 'changed')::boolean, false) and v_now = v_after and not coalesce((b ->> 'end_call')::boolean, false);
    info := pg_temp.said(b) || ' | session still ' || to_char(v_now at time zone 'Asia/Karachi', 'HH24:MI'); return next;

    v_said := 'Theek hai, aath baje kar do';
    b := pg_temp.turn(v_jwt, v_block, v_hist, v_said);
    v_hist := v_hist || jsonb_build_array(jsonb_build_object('who', 'user', 'text', v_said), jsonb_build_object('who', 'agent', 'text', b -> 'reply' ->> 'text'));
    r := pg_temp.call('GET', v_api || '/blocks?goal=' || v_goal, v_jwt);
    select (x ->> 'starts_at')::timestamptz into v_now from jsonb_array_elements(pg_temp.j(r.content)) x where x ->> 'id' = v_block;
    step := '6 "' || v_said || '"'; ms := (b ->> '_ms')::int;
    ok := b -> 'action' ->> 'type' = 'move' and (b ->> 'changed')::boolean
          and to_char(v_now at time zone 'Asia/Karachi', 'DD Mon HH24:MI') = to_char(v_local::date + 1, 'DD Mon') || ' 20:00';
    info := pg_temp.said(b) || ' | session now ' || to_char(v_now at time zone 'Asia/Karachi', 'Dy DD Mon HH24:MI'); return next;

    v_said := 'Shukriya, Allah Hafiz';
    b := pg_temp.turn(v_jwt, v_block, v_hist, v_said);
    step := '7 "' || v_said || '"'; ms := (b ->> '_ms')::int;
    ok := (b ->> 'end_call')::boolean;
    info := pg_temp.said(b); return next;

    b := pg_temp.turn(v_jwt, '00000000-0000-4000-8000-000000000000', '[]'::jsonb);
    step := 'a session that is gone'; ms := (b ->> '_ms')::int;
    ok := (b ->> '_status')::int = 404; info := b -> 'error' ->> 'message'; return next;
  exception when others then
    step := 'error'; ok := false; info := sqlerrm; return next;
  end;

  r := pg_temp.call('DELETE', v_api || '/account', v_jwt);
  step := 'delete test account'; ms := null; ok := r.status = 200; info := left(r.content, 60); return next;
end $$;

select step, ok, ms, info from pg_temp.calltest();
