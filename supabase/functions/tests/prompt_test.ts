import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { EVAL_CONTEXT } from '../_shared/assistant/eval.ts';
import { buildSystemPrompt, ROMAN_URDU_NOTE } from '../_shared/assistant/prompt.ts';

Deno.test('Roman Urdu readers get Roman Urdu replies, even for Urdu-script speech', () => {
  assertEquals(buildSystemPrompt(EVAL_CONTEXT).includes(ROMAN_URDU_NOTE), false);
  const prompt = buildSystemPrompt({ ...EVAL_CONTEXT, romanUrdu: true });
  assertStringIncludes(prompt, 'reads Urdu in Roman letters');
  assertStringIncludes(prompt, 'reply_language "ur-Latn"');
});
