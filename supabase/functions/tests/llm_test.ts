import { assert, assertEquals } from 'jsr:@std/assert@1';
import { chatJson } from '../_shared/assistant/llm.ts';

// Stands in for the provider: rate-limited models answer 429 (once each, when `once`),
// missing ones 404, the rest answer.
function fakeProvider(
  limited: Set<string>,
  opts: { missing?: Set<string>; once?: boolean; retryAfter?: string; badOnce?: Set<string> } = {},
) {
  const models: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    models.push(body.model);
    if (opts.badOnce?.has(body.model)) {
      opts.badOnce.delete(body.model);
      return Promise.resolve(new Response('{"error":{"code":"json_validate_failed","message":"Failed to generate JSON"}}', { status: 400 }));
    }
    if (opts.missing?.has(body.model)) {
      return Promise.resolve(new Response('{"error":{"message":"model not found"}}', { status: 404 }));
    }
    if (limited.has(body.model)) {
      if (opts.once) limited.delete(body.model);
      return Promise.resolve(
        new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': opts.retryAfter ?? '9' } }),
      );
    }
    return Promise.resolve(Response.json({ model: body.model, choices: [{ message: { content: '{"ok":true}' } }] }));
  }) as typeof fetch;
  return { models, restore: () => (globalThis.fetch = real) };
}

Deno.test('on a call, a rate-limited model hands over to the fallback at once', async () => {
  Deno.env.set('LLM_API_KEY', 'gsk_test');
  const provider = fakeProvider(new Set(['openai/gpt-oss-120b']));
  try {
    const t0 = Date.now();
    const out = await chatJson([{ role: 'user', content: 'hi' }], { type: 'object' }, 'test', {
      fallbackModel: 'openai/gpt-oss-20b',
      maxTokens: 1500,
    });
    assertEquals(out.data, { ok: true });
    assertEquals(out.model, 'openai/gpt-oss-20b');
    assertEquals(provider.models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    assert(Date.now() - t0 < 2000, 'no waiting for the limit to reset');
  } finally {
    provider.restore();
    Deno.env.delete('LLM_API_KEY');
  }
});

Deno.test('the fallback is not used when the main model answers', async () => {
  Deno.env.set('LLM_API_KEY', 'gsk_test');
  const provider = fakeProvider(new Set());
  try {
    const out = await chatJson([{ role: 'user', content: 'hi' }], { type: 'object' }, 'test', { fallbackModel: 'openai/gpt-oss-20b' });
    assertEquals(out.model, 'openai/gpt-oss-120b');
    assertEquals(provider.models, ['openai/gpt-oss-120b']);
  } finally {
    provider.restore();
    Deno.env.delete('LLM_API_KEY');
  }
});

Deno.test('a fallback that is not on the account means waiting for the main model after all', async () => {
  Deno.env.set('LLM_API_KEY', 'gsk_test');
  const provider = fakeProvider(new Set(['openai/gpt-oss-120b']), {
    missing: new Set(['openai/gpt-oss-20b']),
    once: true,
    retryAfter: '1',
  });
  try {
    const t0 = Date.now();
    const out = await chatJson([{ role: 'user', content: 'hi' }], { type: 'object' }, 'test', { fallbackModel: 'openai/gpt-oss-20b' });
    assertEquals(out.data, { ok: true });
    assertEquals(provider.models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
    assert(Date.now() - t0 >= 1000, 'waited as the main model asked');
  } finally {
    provider.restore();
    Deno.env.delete('LLM_API_KEY');
  }
});

Deno.test('one bad answer from the fallback is asked again, without waiting', async () => {
  Deno.env.set('LLM_API_KEY', 'gsk_test');
  const provider = fakeProvider(new Set(['openai/gpt-oss-120b']), { badOnce: new Set(['openai/gpt-oss-20b']) });
  try {
    const t0 = Date.now();
    const out = await chatJson([{ role: 'user', content: 'hi' }], { type: 'object' }, 'test', { fallbackModel: 'openai/gpt-oss-20b' });
    assertEquals(out.model, 'openai/gpt-oss-20b');
    assertEquals(provider.models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b']);
    assert(Date.now() - t0 < 2000, 'no waiting');
  } finally {
    provider.restore();
    Deno.env.delete('LLM_API_KEY');
  }
});
