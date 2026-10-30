-- Every minute, call the dispatcher Edge Function with the shared secret from Vault.
-- The function does nothing until its Neon dispatcher URL (and, for pushes, Firebase)
-- are set in the Edge Function secrets.
select cron.unschedule(jobid) from cron.job where jobname = 'deepwork-dispatcher';
select cron.schedule(
  'deepwork-dispatcher',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://kqlrbkgiedrkhzthbqxk.supabase.co/functions/v1/dispatcher',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
  $job$
);
