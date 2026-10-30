-- DeepWork runs its backend on Supabase Edge Functions; app data lives in Neon.
-- This project's own database only holds the cron schedule and one shared secret.
create extension if not exists pg_net;
create extension if not exists pg_cron;
create extension if not exists http with schema extensions;

-- Shared secret between pg_cron and the dispatcher function. Generated here, inside the
-- database, so it never appears in code, logs or chat.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret',
                                'x-cron-secret header for the dispatcher Edge Function');
  end if;
end $$;

-- Lets the Edge Functions read that secret with the service-role key (nobody else).
create or replace function public.dw_cron_secret() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
$$;
revoke all on function public.dw_cron_secret() from public, anon, authenticated;
grant execute on function public.dw_cron_secret() to service_role;
