// Runtime configuration for the Edge Functions.
//
// Only three values are secret, and they come solely from the project's Edge Function
// secrets: LLM_API_KEY, ASSEMBLYAI_API_KEY, ELEVENLABS_API_KEY (plus the optional FCM and
// dispatcher settings). Everything else is public and has a default, so the functions
// work as soon as they are deployed.

const env = (key: string): string | undefined => {
  const value = Deno.env.get(key)?.trim();
  return value ? value : undefined;
};

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
    return { projectId: env('FCM_PROJECT_ID'), serviceAccountJson: env('FCM_SERVICE_ACCOUNT_JSON') };
  },

  get dispatcherDbUrl() {
    return env('NEON_DATABASE_URL_DISPATCHER');
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

export const VERSION = '1.0.0';
