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

## Keys and secrets

The keys live on the server only, never in the app. Each one can be an **Edge Function
secret** (Dashboard → Edge Functions → Secrets) or a **Vault** secret (Dashboard → Project
Settings → Vault, under the name in brackets); an Edge Function secret wins.

| Secret | Used for |
| --- | --- |
| `LLM_API_KEY` (`llm_api_key`) | Groq (`gsk_…`) or xAI (`xai-…`) key; the provider is picked from the prefix |
| `ASSEMBLYAI_API_KEY` (`assemblyai_api_key`) | speech to text (English and Urdu) |
| `ELEVENLABS_API_KEY` (`elevenlabs_api_key`) | spoken replies |
| `FCM_SERVICE_ACCOUNT_JSON` (`fcm_service_account`) | Firebase service account for push |
| `NEON_DATABASE_URL_DISPATCHER` (`dispatcher_db_url`) | the dispatcher's database login (`deepwork_worker`, see `db/roles.sql.example`) |

Optional: `LLM_MODEL` (default `openai/gpt-oss-120b` on Groq), `ELEVENLABS_VOICE_ID`,
`ELEVENLABS_MODEL_ID`, `FCM_PROJECT_ID` (default: the service account's project).
`GET /functions/v1/api/health` shows what is configured.

**Spoken replies.** ElevenLabs refuses free-plan keys that are used from a server
("detected_unusual_activity"), so with a free key the app speaks replies with the phone's
own voice instead (Urdu where the phone has an Urdu voice). A paid ElevenLabs plan brings
the ElevenLabs voice back without any change to the app.

**Roman Urdu.** Typed Roman Urdu, Urdu script and English are all understood. Urdu speech
that is first heard as low-confidence English is transcribed again as Urdu. When the app
language is Roman Urdu, replies are written in Roman Urdu and spoken from Urdu script.

## Reminders and push

The dispatcher (pg_cron, every minute) marks missed sessions, keeps the 14-day horizon
filled and sends due reminders through Firebase Cloud Messaging. When a phone registers its
push token and the server has Firebase set up, the server sends that phone's reminders as
data messages that the app shows exactly like its own (Start / Snooze / Done buttons, the
same links), and the phone schedules none itself. Without push (no Google Play services,
notifications off, offline at startup) the phone schedules its reminders locally, 7 days
ahead, as before. `app/google-services.json` holds the Firebase app's public identifiers.

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
same way; it calls `POST /assistant/eval` with the project's cron secret from Vault and
answers with the pass count and the failures (39 of 40 with Groq `openai/gpt-oss-120b`).
`POST /assistant/voice-check` (same secret) runs speech → text → plan → speech with the real
providers, using the clips in `supabase/tests/audio` or ElevenLabs.

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
