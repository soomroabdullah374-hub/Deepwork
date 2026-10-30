-- API keys for the Edge Functions can live in Vault (Dashboard → Project Settings → Vault)
-- instead of the Edge Function secrets. The functions read them with the service-role key
-- through this function; nobody else can call it, and it only hands out these names.
-- An Edge Function secret with the matching env name (LLM_API_KEY, …) still wins.
create or replace function public.dw_secrets() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    from vault.decrypted_secrets
   where name in ('llm_api_key', 'assemblyai_api_key', 'elevenlabs_api_key',
                  'fcm_service_account', 'dispatcher_db_url')
$$;
revoke all on function public.dw_secrets() from public, anon, authenticated;
grant execute on function public.dw_secrets() to service_role;
