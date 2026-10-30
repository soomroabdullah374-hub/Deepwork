# DeepWork

Turn a goal with a deadline into a weekly rhythm of focus sessions that never overlap
anything else in your week, with gentle reminders and a voice assistant that understands
English, Urdu and Roman Urdu.

| Part | Where | What |
| --- | --- | --- |
| Mobile app | `app/` | Expo SDK 58 (React Native 0.88, Expo Router, Reanimated). Android APK built on GitHub Actions. |
| API | `supabase/functions/api` | One Supabase Edge Function (Deno): sign-in relay, schedule API, voice assistant. |
| Dispatcher | `supabase/functions/dispatcher` | Edge Function called every minute by `pg_cron` (missed sessions, horizon, optional FCM push). |
| Database | `db/` | Neon Postgres: schema, row-level security, the no-overlap constraint, the session generator and RPCs. |

## How it fits together

```
phone ──HTTPS──▶ Supabase Edge Function `api` ──Neon Data API (user's JWT, RLS)──▶ Neon Postgres
  │                    │  └─▶ Neon Auth (a private account per phone, no sign-in screen)
  │                    ├─▶ AssemblyAI (speech → text, English + Urdu)
  │                    ├─▶ Groq / xAI (plan the change, strict JSON schema)
  │                    └─▶ ElevenLabs (spoken reply, Urdu script for Urdu)
  └── local notifications scheduled on the phone from the synced schedule
pg_cron (Supabase) ──every minute──▶ Edge Function `dispatcher`
```

* **No double-booking, ever.** `calendar_blocks` has an `EXCLUDE USING gist` constraint per
  user over the block's time range. The generator, the app and the assistant all go through
  it; clashes come back as friendly 409s naming what is already there.
* **No sign-in screen.** On first use the app creates a private account for the phone (a random
  `@deepwork.invalid` address and password, kept in the phone's secure storage) and signs back in
  with it whenever the session runs out. Your plan is tied to the app on that phone; Settings ›
  Export keeps a copy, and Settings › Delete all my data removes everything.
* **Row-level security on every table.** The API never holds a database password for user
  requests: it forwards the user's own Neon Auth JWT to the Neon Data API.
* **The assistant never writes on its own.** It proposes a plan; the server resolves every
  action against your real data and checks every slot (also against the rest of the same
  request); you apply what you want in one transaction and can undo for 10 seconds.
* **Secrets stay on the server.** The APK contains only the public API URL. CI fails the
  build if anything that looks like a key shows up in the JavaScript bundle.

## Install the app

Download the latest APK from the
[Releases page](https://github.com/soomroabdullah374-hub/Deepwork/releases), open it on your
Android phone and allow installs from that source when asked.

## Turn on the voice assistant

The assistant needs three API keys, set as **Edge Function secrets** in the Supabase
dashboard (Project → Edge Functions → Secrets), never in the app:

| Secret | Used for |
| --- | --- |
| `LLM_API_KEY` | Groq (`gsk_…`) or xAI (`xai-…`) key; the provider is picked from the prefix |
| `ASSEMBLYAI_API_KEY` | speech to text |
| `ELEVENLABS_API_KEY` | spoken replies (optional) |

Optional: `LLM_MODEL` (default `openai/gpt-oss-120b` on Groq), `ELEVENLABS_VOICE_ID`,
`ELEVENLABS_MODEL_ID`. `GET /functions/v1/api/health` shows which ones are configured.

## Server push (optional)

Reminders already work through local notifications. For server push through Firebase Cloud
Messaging, add `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON` and
`NEON_DATABASE_URL_DISPATCHER` (a connection string for the `dispatcher` role, see
`db/roles.sql.example`) to the Edge Function secrets, and a `google-services.json` to the app.

## Develop

```bash
# database tests (local Postgres 16)
scripts/test-db-local.sh

# Edge Functions: type-check, lint, unit tests
cd supabase/functions && deno check api/index.ts dispatcher/index.ts && deno lint && deno test --allow-env tests/

# app: type-check and unit tests
cd app && npm ci && npx tsc --noEmit && npx jest
```

The end-to-end check of the deployed API is `supabase/tests/e2e.sql` (run it in the Supabase
SQL editor). The 40-utterance assistant eval is `supabase/tests/assistant_eval.sql`, run the
same way once `LLM_API_KEY` is set; it calls `POST /assistant/eval` with the project's cron
secret from Vault and answers with the pass count and the failures.

Deploy the functions from a checkout with the Supabase CLI:

```bash
supabase functions deploy api --no-verify-jwt
supabase functions deploy dispatcher --no-verify-jwt
```

## Build the APK

Every push that touches `app/` runs `.github/workflows/android.yml` (type-check, tests,
`expo prebuild`, `gradlew assembleRelease`). A commit message containing `[apk]` (or a manual
run) also publishes a GitHub Release with the APK. Without a release keystore the APK is
signed with the debug key, which is fine for installing directly; for the Play Store add
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD` as repository secrets.
