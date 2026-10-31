// Runtime configuration for the Edge Functions.
//
// The secret values are LLM_API_KEY, ASSEMBLYAI_API_KEY, ELEVENLABS_API_KEY,
// FCM_SERVICE_ACCOUNT_JSON and NEON_DATABASE_URL_DISPATCHER. Each comes from the project's
// Edge Function secrets or, when it isn't set there, from the project's Vault (read with
// the service-role key through public.dw_secrets()). Everything else is public and has a
// default, so the functions work as soon as they are deployed.

// Env name → Vault secret name.
const VAULT_NAMES: Record<string, string> = {
  LLM_API_KEY: 'llm_api_key',
  ASSEMBLYAI_API_KEY: 'assemblyai_api_key',
  ELEVENLABS_API_KEY: 'elevenlabs_api_key',
  FCM_SERVICE_ACCOUNT_JSON: 'fcm_service_account',
  NEON_DATABASE_URL_DISPATCHER: 'dispatcher_db_url',
};
let vault: Record<string, string> = {};
let vaultNextCheck = 0;

const env = (key: string): string | undefined => {
  const value = Deno.env.get(key)?.trim() || (VAULT_NAMES[key] ? vault[VAULT_NAMES[key]]?.trim() : undefined);
  return value ? value : undefined;
};

/** Refresh the Vault copy of the secrets: every 5 minutes, or 30 s after a failed read. */
export async function loadSecrets(): Promise<void> {
  if (Date.now() < vaultNextCheck) return;
  const url = config.supabaseUrl;
  const key = config.supabaseServiceKey;
  vaultNextCheck = Date.now() + 30_000;
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/dw_secrets`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.error('could not read secrets from Vault', res.status);
      await res.body?.cancel();
      return;
    }
    const data = await res.json();
    if (data && typeof data === 'object') vault = data as Record<string, string>;
    vaultNextCheck = Date.now() + 5 * 60_000;
  } catch (err) {
    console.error('could not read secrets from Vault', (err as Error).name);
  }
}

export type LlmProvider = 'groq' | 'xai';

function llmProvider(): LlmProvider {
  const explicit = env('LLM_PROVIDER')?.toLowerCase();
  if (explicit === 'groq' || explicit === 'xai') return explicit;
  // A gsk_ key is Groq (groq.com); xai- is xAI Grok.
  return env('LLM_API_KEY')?.startsWith('xai-') ? 'xai' : 'groq';
}

const LLM_DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string; label: string }> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', label: 'Groq' },
  xai: { baseUrl: 'https://api.x.ai/v1', model: 'grok-4-fast-non-reasoning', label: 'Grok' },
};

export const config = {
  neonAuthUrl:
    env('NEON_AUTH_BASE_URL') ??
    'https://ep-long-hall-a1adbrls.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth',
  neonDataApiUrl:
    env('NEON_DATA_API_URL') ??
    'https://ep-long-hall-a1adbrls.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1',

  get llm() {
    const provider = llmProvider();
    const d = LLM_DEFAULTS[provider];
    return {
      provider,
      label: d.label,
      apiKey: env('LLM_API_KEY'),
      baseUrl: (env('LLM_BASE_URL') ?? d.baseUrl).replace(/\/+$/, ''),
      model: env('LLM_MODEL') ?? d.model,
      reasoningEffort: env('LLM_REASONING_EFFORT') ?? 'medium',
    };
  },

  get assemblyAiKey() {
    return env('ASSEMBLYAI_API_KEY');
  },

  get elevenLabs() {
    return {
      apiKey: env('ELEVENLABS_API_KEY'),
      // eleven_v3 lists Urdu among its languages; Flash v2.5 is faster for English.
      modelUrdu: env('ELEVENLABS_MODEL_ID') ?? 'eleven_v3',
      modelEnglish: env('ELEVENLABS_MODEL_ID') ?? 'eleven_flash_v2_5',
      // A premade multilingual voice available on every account.
      voiceId: env('ELEVENLABS_VOICE_ID') ?? 'JBFqnCBsd6RMkjVDRZzb',
    };
  },

  get fcm() {
    const serviceAccountJson = env('FCM_SERVICE_ACCOUNT_JSON');
    let projectId = env('FCM_PROJECT_ID');
    if (!projectId && serviceAccountJson) {
      try {
        projectId = (JSON.parse(serviceAccountJson) as { project_id?: string }).project_id;
      } catch {
        projectId = undefined;
      }
    }
    return { projectId, serviceAccountJson };
  },

  get dispatcherDbUrl() {
    return env('NEON_DATABASE_URL_DISPATCHER');
  },

  /** Server push needs the Firebase service account and the dispatcher's database login. */
  get pushConfigured(): boolean {
    const fcm = this.fcm;
    return Boolean(fcm.projectId && fcm.serviceAccountJson && this.dispatcherDbUrl);
  },

  supabaseUrl: env('SUPABASE_URL'),
  get supabaseServiceKey(): string | undefined {
    const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
    if (legacy) return legacy;
    // Newer projects expose secret keys as a JSON map.
    const keys = env('SUPABASE_SECRET_KEYS');
    if (!keys) return undefined;
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      return parsed.default ?? Object.values(parsed)[0];
    } catch {
      return undefined;
    }
  },
};

export const VERSION = '1.2.0';
