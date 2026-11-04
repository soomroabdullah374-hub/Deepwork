import { assertEquals } from 'jsr:@std/assert@1';
import { spokenText } from '../_shared/assistant/stt.ts';

const seg = (text: string, no_speech_prob: number, avg_logprob: number) => ({ text, no_speech_prob, avg_logprob });

Deno.test('what Whisper makes up over silence or noise is dropped', () => {
  assertEquals(spokenText([seg(' you', 0.3, -0.4)]), '');
  assertEquals(spokenText([seg(' Thank you.', 0.05, -0.9)]), '');
  assertEquals(spokenText([seg(' شکریہ', 0.4, -0.5)]), '');
  assertEquals(spokenText([seg(' Hello', 0.7, -0.9)]), ''); // Whisper's own silence test
  assertEquals(spokenText([seg(' Something', 0.85, -0.2)]), '');
});

Deno.test('real words stay, even short ones and a clear "thank you"', () => {
  assertEquals(spokenText([seg(' Haan, kar do.', 0.02, -0.25)]), 'Haan, kar do.');
  assertEquals(spokenText([seg(' Thank you.', 0.01, -0.2)]), 'Thank you.');
  assertEquals(spokenText([seg(' Das minute baad.', 0.01, -0.3), seg(' Thank you.', 0.5, -0.5)]), 'Das minute baad.');
  assertEquals(spokenText([seg(' دس منٹ بعد کروں گا', 0.1, -0.5)]), 'دس منٹ بعد کروں گا');
});
