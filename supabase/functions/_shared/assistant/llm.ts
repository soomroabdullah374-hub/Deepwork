// OpenAI-compatible chat completions for Groq or xAI, always at temperature 0.
// Tries strict JSON-schema output first; if the provider or model rejects a parameter,
// falls back step by step (and remembers what worked while the isolate is warm).

import { config } from '../env.ts';
import { fetchWithTimeout, HttpError } from '../http.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type Mode = 'schema_strict_reasoning' | 'schema_strict' | 'json_object' | 'plain';
const MODES: Mode[] = ['schema_strict_reasoning', 'schema_strict', 'json_object', 'plain'];
let preferredMode: Mode | null = null;

export class LlmNotConfigured extends HttpError {
  constructor() {
    super(503, 'ai_not_configured', 'The assistant is not set up yet: add LLM_API_KEY to the Supabase Edge Function secrets.');
  }
}

export interface ChatOptions {
  /** Less thinking for quick turns (a phone call); defaults to LLM_REASONING_EFFORT. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Someone is waiting on the phone: when the main model is rate limited, ask this model
   * at once (it has its own limit) instead of waiting for the limit to reset.
   */
  fallbackModel?: string;
  /** Cap on the answer, thinking included (default 4096). */
  maxTokens?: number;
  /** Longest total wait for rate limits before giving up (someone on the phone can't wait long). */
  waitBudgetMs?: number;
}

function body(
  mode: Mode,
  model: string,
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  name: string,
  opts: ChatOptions,
) {
  const llm = config.llm;
  // Reasoning tokens count toward the limit, so leave room for them.
  const base: Record<string, unknown> = {
    model,
    messages,
    temperature: 0,
    max_completion_tokens: opts.maxTokens ?? 4096,
  };
  if (mode === 'schema_strict_reasoning' || mode === 'schema_strict') {
    base.response_format = { type: 'json_schema', json_schema: { name, schema, strict: true } };
  }
  if (mode === 'schema_strict_reasoning') {
    base.reasoning_effort = opts.reasoningEffort ?? llm.reasoningEffort;
    base.include_reasoning = false;
  }
  if (mode === 'json_object') {
    base.response_format = { type: 'json_object' };
    base.messages = [
      ...messages,
      { role: 'system', content: `Return only a JSON object that matches this JSON schema:\n${JSON.stringify(schema)}` },
    ];
  }
  if (mode === 'plain') {
    base.messages = [
      ...messages,
      { role: 'system', content: `Reply with only a JSON object (no code fences) that matches:\n${JSON.stringify(schema)}` },
    ];
  }
  return base;
}

/** The provider's error code and message, short, for the logs (never the model's output). */
function errorOf(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: { code?: string; type?: string; message?: string } }).error ?? {};
    return `${e.code ?? e.type ?? ''} ${(e.message ?? '').slice(0, 160)}`.trim();
  } catch {
    return text.slice(0, 120);
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('no JSON in model output');
  }
}

/** Returns the parsed JSON object the model produced. */
export async function chatJson(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  name: string,
  opts: ChatOptions = {},
): Promise<{ data: unknown; model: string; mode: Mode }> {
  const llm = config.llm;
  if (!llm.apiKey) throw new LlmNotConfigured();
  const modes = preferredMode ? [preferredMode, ...MODES.filter((m) => m !== preferredMode)] : MODES;
  let model = llm.model;
  let fallback = opts.fallbackModel && opts.fallbackModel !== llm.model ? opts.fallbackModel : null;
  let mainWait = 0; // what the main model asked us to wait, when we went to the fallback instead
  let fallbackFails = 0;
  let waited = 0;
  const pause = async (seconds: number) => {
    if (waited + seconds * 1000 > (opts.waitBudgetMs ?? Infinity)) {
      throw new HttpError(503, 'ai_busy', 'The assistant is busy right now. Please try again in a minute.');
    }
    waited += seconds * 1000;
    await new Promise((r) => setTimeout(r, seconds * 1000));
  };
  let lastError = '';
  for (const mode of modes) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchWithTimeout(
        `${llm.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${llm.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body(mode, model, messages, schema, name, opts)),
        },
        60_000,
      );
      if (res.status === 429) {
        const wait = Math.min(Number(res.headers.get('retry-after') ?? '2') || 2, 20);
        console.warn('llm rate limited', model, `retry-after ${wait}s`, `tokens left ${res.headers.get('x-ratelimit-remaining-tokens') ?? '?'}`);
        await res.body?.cancel();
        if (fallback && model !== fallback) {
          // someone is waiting: the fallback model has its own limit, so ask it now
          mainWait = wait;
          model = fallback;
          continue;
        }
        // otherwise wait as told (capped) and try the same mode again
        await pause(wait);
        continue;
      }
      if (!res.ok && model === fallback) {
        const why = errorOf(await res.text());
        const missing = res.status === 404 || res.status === 403 || /model_not_found|model_decommissioned|does not exist/i.test(why);
        console.warn('llm fallback failed', model, res.status, why);
        if (missing || ++fallbackFails >= 2) {
          // not on this account, or failing again: wait for the main model after all
          fallback = null;
          model = llm.model;
          await pause(mainWait);
        }
        // otherwise (a one-off bad answer) ask the fallback once more
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        throw new HttpError(503, 'ai_auth', 'The LLM key was rejected. Check LLM_API_KEY in the Supabase secrets.');
      }
      if (!res.ok) {
        lastError = `${res.status} ${(await res.text()).slice(0, 300)}`;
        // a 400 means this mode's parameters aren't supported here: try the next mode
        if (res.status === 400) break;
        if (res.status >= 500 && attempt < 2) continue;
        break;
      }
      const out = await res.json();
      const content: string = out?.choices?.[0]?.message?.content ?? '';
      try {
        const data = extractJson(content);
        preferredMode = mode;
        return { data, model: out?.model ?? model, mode };
      } catch (err) {
        lastError = `unparseable output: ${(err as Error).message}`;
        break;
      }
    }
  }
  console.error('llm failed', lastError);
  throw new HttpError(502, 'ai_failed', 'The assistant could not answer just now. Please try again.');
}
