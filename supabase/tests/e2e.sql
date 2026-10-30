-- End-to-end check of the deployed API. Run it in the Supabase SQL editor (or any SQL
-- client on this project): it uses the `http` extension, so the requests go over the
-- internet exactly like the app's.
--
-- It signs up a throwaway user with a random password, exercises the main routes with
-- that user's Neon Auth JWT, then deletes the account. Tokens and passwords never leave
-- the function; the result only says what each step returned.

create or replace function pg_temp.j(p text) returns jsonb
language plpgsql immutable as $$
begin
  return p::jsonb;
exception when others then
  return null;
end $$;

create or replace function pg_temp.call(p_method text, p_url text, p_jwt text, p_body jsonb default null)
returns extensions.http_response
language sql as $$
  select extensions.http((
    p_method, p_url,
    array[extensions.http_header('Authorization', 'Bearer ' || p_jwt),
          extensions.http_header('x-timezone', 'Asia/Karachi')],
    case when p_body is null then null else 'application/json' end,
    case when p_body is null then null else p_body::text end
  )::extensions.http_request)
$$;

create or replace function pg_temp.e2e()
returns table (step text, status int, ok boolean, info text)
language plpgsql as $$
declare
  v_auth   text := 'https://ep-long-hall-a1adbrls.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth';
  v_api    text := 'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/api';
  v_email  text := 'e2e-' || encode(extensions.gen_random_bytes(5), 'hex') || '@example.com';
  v_pw     text := encode(extensions.gen_random_bytes(18), 'hex');
  v_today  date := (now() at time zone 'Asia/Karachi')::date;
  v_cookie text;
  v_jwt    text;
  r        extensions.http_response;
  b        jsonb;
  v_goal   text;
  v_block  text;
  v_slot   jsonb;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '60000');

  -- ── auth
  r := extensions.http(('POST', v_auth || '/sign-up/email',
         array[extensions.http_header('Origin', 'https://localhost')], 'application/json',
         jsonb_build_object('email', v_email, 'password', v_pw, 'name', 'E2E Tester')::text)::extensions.http_request);
  select string_agg(split_part(h.value, ';', 1), '; ') into v_cookie
    from unnest(r.headers) h where lower(h.field) = 'set-cookie';
  step := 'auth sign-up'; status := r.status; ok := r.status = 200 and v_cookie is not null;
  info := coalesce(pg_temp.j(r.content) -> 'user' ->> 'email', left(r.content, 160)); return next;

  r := extensions.http(('GET', v_auth || '/get-session',
         array[extensions.http_header('Origin', 'https://localhost'), extensions.http_header('Cookie', v_cookie)],
         null, null)::extensions.http_request);
  select h.value into v_jwt from unnest(r.headers) h where lower(h.field) = 'set-auth-jwt';
  if v_jwt is null then
    r := extensions.http(('GET', v_auth || '/token',
           array[extensions.http_header('Origin', 'https://localhost'), extensions.http_header('Cookie', v_cookie)],
           null, null)::extensions.http_request);
    v_jwt := pg_temp.j(r.content) ->> 'token';
  end if;
  step := 'auth JWT'; status := r.status; ok := v_jwt is not null;
  info := case when v_jwt is null then left(r.content, 160) else 'JWT issued' end; return next;
  if v_jwt is null then return; end if;

  r := pg_temp.call('GET', v_api || '/state', 'not-a-token');
  step := 'reject bad token'; status := r.status; ok := r.status = 401; info := pg_temp.j(r.content) -> 'error' ->> 'code'; return next;

  -- ── first load
  r := pg_temp.call('GET', v_api || '/state', v_jwt);
  b := pg_temp.j(r.content);
  step := 'state (first load)'; status := r.status;
  ok := r.status = 200 and b -> 'profile' ->> 'timezone' = 'Asia/Karachi';
  info := case when r.status = 200
               then format('tz=%s name=%s goals=%s', b -> 'profile' ->> 'timezone', b -> 'profile' ->> 'display_name',
                           jsonb_array_length(b -> 'goals'))
               else left(r.content, 200) end; return next;

  -- ── commitments and clash checks
  r := pg_temp.call('POST', v_api || '/commitments', v_jwt,
         '{"title":"Training class","weekdays":[1,2,3,4],"start_time":"14:00","duration_min":180}');
  step := 'add commitment'; status := r.status; ok := r.status = 201; info := left(r.content, 120); return next;

  r := pg_temp.call('POST', v_api || '/commitments/check', v_jwt,
         '{"title":"Gym","weekdays":[2],"start_time":"15:00","duration_min":60}');
  b := pg_temp.j(r.content);
  step := 'clash check finds the class'; status := r.status;
  ok := r.status = 200 and (b ->> 'ok')::boolean is false and b -> 'clashes' -> 0 -> 'with' ->> 'title' = 'Training class';
  info := b -> 'clashes' -> 0 ->> 'message'; return next;

  r := pg_temp.call('POST', v_api || '/commitments', v_jwt,
         '{"title":"Gym","weekdays":[2],"start_time":"15:00","duration_min":60}');
  step := 'overlapping commitment refused'; status := r.status;
  ok := r.status = 409 and pg_temp.j(r.content) -> 'error' ->> 'code' = 'clash';
  info := pg_temp.j(r.content) -> 'error' ->> 'message'; return next;

  -- ── new goal flow
  r := pg_temp.call('POST', v_api || '/goals/draft-plan', v_jwt, jsonb_build_object(
         'title', 'Finish AI Agent portfolio project', 'deadline', (v_today + 50)::text,
         'rule', jsonb_build_object('weekdays', jsonb_build_array(1, 3, 6), 'start_time', '20:00', 'duration_min', 90)));
  b := pg_temp.j(r.content);
  step := 'draft milestones'; status := r.status; ok := r.status = 200 and jsonb_array_length(b -> 'milestones') >= 2;
  info := format('source=%s milestones=%s sessions=%s hours=%s', b ->> 'source', jsonb_array_length(b -> 'milestones'),
                 b -> 'capacity' ->> 'sessions', b -> 'capacity' ->> 'hours'); return next;

  r := pg_temp.call('POST', v_api || '/goals', v_jwt, jsonb_build_object(
         'title', 'Finish AI Agent portfolio project', 'why', 'Ship one agent end to end',
         'deadline', (v_today + 50)::text, 'milestones', b -> 'milestones',
         'rule', jsonb_build_object('weekdays', jsonb_build_array(1, 3, 6), 'start_time', '20:00',
                                    'duration_min', 90, 'lead_min', 10)));
  b := pg_temp.j(r.content);
  v_goal := b ->> 'goal_id';
  step := 'create goal'; status := r.status; ok := r.status = 201 and v_goal is not null;
  info := format('conflicts=%s', jsonb_array_length(b -> 'conflicts')); return next;

  r := pg_temp.call('GET', v_api || '/state', v_jwt);
  b := pg_temp.j(r.content);
  select x ->> 'id' into v_block from jsonb_array_elements(b -> 'blocks') x
   where x ->> 'kind' = 'session' and x ->> 'status' = 'planned' and (x ->> 'starts_at')::timestamptz > now() + interval '1 hour'
   order by (x ->> 'starts_at')::timestamptz limit 1;
  step := 'state with goal'; status := r.status;
  ok := r.status = 200 and jsonb_array_length(b -> 'goals') = 1 and v_block is not null;
  info := format('sessions=%s commitment blocks=%s milestones=%s',
                 (select count(*) from jsonb_array_elements(b -> 'blocks') x where x ->> 'kind' = 'session'),
                 (select count(*) from jsonb_array_elements(b -> 'blocks') x where x ->> 'kind' = 'commitment'),
                 jsonb_array_length(b -> 'goals' -> 0 -> 'milestones')); return next;

  -- ── session actions
  r := pg_temp.call('GET', v_api || '/blocks/' || v_block || '/free-slots', v_jwt);
  b := pg_temp.j(r.content);
  select s into v_slot from jsonb_array_elements(b -> 'slots') s where s -> 'taken' is null limit 1;
  step := 'free slots to move to'; status := r.status; ok := r.status = 200 and v_slot is not null;
  info := (select string_agg(format('%s (%s)', to_char((s ->> 'starts_at')::timestamptz at time zone 'Asia/Karachi', 'Dy HH24:MI'), s ->> 'reason'), ', ')
             from jsonb_array_elements(b -> 'slots') s); return next;

  r := pg_temp.call('POST', v_api || '/blocks/' || v_block || '/move', v_jwt,
         jsonb_build_object('starts_at', v_slot ->> 'starts_at'));
  step := 'move session'; status := r.status; ok := r.status = 200 and pg_temp.j(r.content) ->> 'starts_at' is not null;
  info := pg_temp.j(r.content) ->> 'status'; return next;

  r := pg_temp.call('POST', v_api || '/blocks/' || v_block || '/start', v_jwt, '{}');
  step := 'start session'; status := r.status; ok := pg_temp.j(r.content) ->> 'status' = 'in_progress';
  info := pg_temp.j(r.content) ->> 'status'; return next;

  r := pg_temp.call('POST', v_api || '/blocks/' || v_block || '/finish', v_jwt, '{"minutes":25}');
  step := 'finish session'; status := r.status;
  ok := pg_temp.j(r.content) ->> 'status' = 'done' and (pg_temp.j(r.content) ->> 'minutes_done')::int = 25;
  info := format('%s, %s min', pg_temp.j(r.content) ->> 'status', pg_temp.j(r.content) ->> 'minutes_done'); return next;

  r := pg_temp.call('PUT', v_api || '/goals/' || v_goal || '/rule', v_jwt,
         '{"weekdays":[1,2,4],"start_time":"15:00","duration_min":60,"lead_min":15}');
  b := pg_temp.j(r.content);
  step := 'rhythm onto class time reports clashes'; status := r.status;
  ok := r.status = 200 and jsonb_array_length(b -> 'conflicts') > 0;
  info := format('conflicts=%s first=%s', jsonb_array_length(b -> 'conflicts'), b -> 'conflicts' -> 0 ->> 'clash_title'); return next;

  r := pg_temp.call('PUT', v_api || '/goals/' || v_goal || '/rule', v_jwt,
         '{"weekdays":[1,3,6],"start_time":"20:00","duration_min":90,"lead_min":10}');
  step := 'rhythm back to evenings'; status := r.status;
  ok := r.status = 200 and jsonb_array_length(pg_temp.j(r.content) -> 'conflicts') = 0;
  info := left(r.content, 80); return next;

  r := pg_temp.call('PATCH', v_api || '/profile', v_jwt, '{"quiet_start":"22:30","speak_replies":false}');
  step := 'settings'; status := r.status; ok := r.status = 200 and pg_temp.j(r.content) ->> 'quiet_start' = '22:30:00';
  info := pg_temp.j(r.content) ->> 'quiet_start'; return next;

  -- ── assistant (answers 503 until the AI keys are in the Edge Function secrets)
  r := pg_temp.call('POST', v_api || '/assistant/plan', v_jwt, '{"text":"Add gym tomorrow at 7 pm"}');
  b := pg_temp.j(r.content);
  step := 'assistant plan'; status := r.status;
  ok := r.status = 200 or (r.status = 503 and b -> 'error' ->> 'code' = 'ai_not_configured');
  info := coalesce(b ->> 'reply_text', b -> 'error' ->> 'message'); return next;

  -- ── export, then delete everything
  r := pg_temp.call('GET', v_api || '/export', v_jwt);
  b := pg_temp.j(r.content);
  step := 'export'; status := r.status; ok := r.status = 200 and b ? 'calendar_blocks';
  info := format('goals=%s blocks=%s', jsonb_array_length(b -> 'goals'), jsonb_array_length(b -> 'calendar_blocks')); return next;

  r := pg_temp.call('DELETE', v_api || '/account', v_jwt);
  step := 'delete account'; status := r.status; ok := r.status = 200 and (pg_temp.j(r.content) ->> 'deleted')::boolean;
  info := left(r.content, 80); return next;
end $$;

select * from pg_temp.e2e();
