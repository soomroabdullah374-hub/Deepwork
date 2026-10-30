-- The 40-utterance assistant eval (02_Prompts/ASSISTANT_SYSTEM_PROMPT.md), run against the
-- deployed API. Paste the whole file into the Supabase SQL editor once LLM_API_KEY is in the
-- Edge Function secrets. It answers with one row: how many cases passed, and the failures.
--
-- The eval makes real model calls, so the API accepts it only with this project's cron
-- secret, read from Vault here (it never leaves the database). Cases go in small batches so
-- each request stays inside the Edge Function time limit, also when a free LLM key has to
-- wait out its per-minute limit. To run part of it, change the range in the last select.

create or replace function pg_temp.j(p text) returns jsonb
language plpgsql immutable as $$
begin
  return p::jsonb;
exception when others then
  return null;
end $$;

create or replace function pg_temp.assistant_eval(p_first int default 1, p_last int default 40, p_batch int default 4)
returns table (n int, pass boolean, utterance text, expected jsonb, got jsonb, note text)
language plpgsql as $$
declare
  v_url    text := 'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/api/assistant/eval';
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret');
  v_from   int := greatest(p_first, 1);
  v_to     int;
  v_status int;
  v_body   text;
  b        jsonb;
  x        jsonb;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '150000');
  while v_from <= least(p_last, 40) loop
    v_to := least(v_from + p_batch - 1, p_last, 40);
    begin
      select status, content into v_status, v_body
        from extensions.http(('POST', v_url,
               array[extensions.http_header('x-cron-secret', v_secret)], 'application/json',
               jsonb_build_object('cases', (select jsonb_agg(c) from generate_series(v_from, v_to) c))::text
             )::extensions.http_request);
    exception when others then
      v_status := 0; v_body := sqlerrm;
    end;
    b := pg_temp.j(v_body);
    if v_status = 200 and b ? 'results' then
      for x in select value from jsonb_array_elements(b -> 'results') loop
        n := (x ->> 'n')::int; pass := (x ->> 'pass')::boolean; utterance := x ->> 'text';
        expected := x -> 'expected'; got := x -> 'got';
        note := coalesce('error: ' || (x ->> 'error'), format('%s ms', x ->> 'ms'));
        return next;
      end loop;
    else
      for i in v_from .. v_to loop
        n := i; pass := false; utterance := null; expected := null; got := null;
        note := format('batch failed (%s): %s', v_status, left(coalesce(b -> 'error' ->> 'message', v_body), 160));
        return next;
      end loop;
    end if;
    v_from := v_to + 1;
  end loop;
end $$;

select count(*) filter (where pass) as passed,
       count(*) as total,
       jsonb_agg(jsonb_build_object('n', n, 'said', utterance, 'expected', expected, 'got', got, 'note', note)
                 order by n) filter (where not pass) as failures
  from pg_temp.assistant_eval(1, 40);
