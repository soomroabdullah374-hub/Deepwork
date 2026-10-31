// The hands-free conversation on the assistant screen: what to say after each step, what
// to listen for next, and how to read a short spoken answer ("haan", "theek hai kar do",
// "nahi rehne do", "ہاں", "no thanks") in English, Roman Urdu and Urdu.

import type { AssistantPlan } from './types';

export type ReplyLanguage = AssistantPlan['reply_language'];

/** Shown and spoken: `tts` is what the voice reads (Urdu script for Urdu replies). */
export interface Line {
  text: string;
  tts: string;
}

/** What the next thing you say is taken as. */
export type Listen =
  | { kind: 'request' } // a new change or question
  | { kind: 'answer'; index: number } // the answer to a question card, or a new time for a clash
  | { kind: 'confirm' } // yes saves, no doesn't, anything else is a new request
  | { kind: 'more' }; // after saving or an answer: a new request, or no to finish

type LineKey = 'confirmOne' | 'confirmMany' | 'when' | 'done' | 'more' | 'notSaved' | 'goAhead' | 'bye';

const LINES: Record<LineKey, Record<ReplyLanguage, Line>> = {
  confirmOne: {
    en: { text: 'Shall I save it?', tts: 'Shall I save it?' },
    'ur-Latn': { text: 'Save kar doon?', tts: 'محفوظ کر دوں؟' },
    ur: { text: 'محفوظ کر دوں؟', tts: 'محفوظ کر دوں؟' },
  },
  confirmMany: {
    en: { text: 'Shall I save these?', tts: 'Shall I save these?' },
    'ur-Latn': { text: 'Yeh sab save kar doon?', tts: 'یہ سب محفوظ کر دوں؟' },
    ur: { text: 'یہ سب محفوظ کر دوں؟', tts: 'یہ سب محفوظ کر دوں؟' },
  },
  when: {
    en: { text: 'When should it be instead?', tts: 'When should it be instead?' },
    'ur-Latn': { text: 'Kis waqt rakhoon?', tts: 'کس وقت رکھوں؟' },
    ur: { text: 'کس وقت رکھوں؟', tts: 'کس وقت رکھوں؟' },
  },
  done: {
    en: { text: 'Done.', tts: 'Done.' },
    'ur-Latn': { text: 'Ho gaya.', tts: 'ہو گیا۔' },
    ur: { text: 'ہو گیا۔', tts: 'ہو گیا۔' },
  },
  more: {
    en: { text: 'Anything else?', tts: 'Anything else?' },
    'ur-Latn': { text: 'Aur kuch?', tts: 'اور کچھ؟' },
    ur: { text: 'اور کچھ؟', tts: 'اور کچھ؟' },
  },
  notSaved: {
    en: { text: "Okay, I haven't saved anything.", tts: "Okay, I haven't saved anything." },
    'ur-Latn': { text: 'Theek hai, kuch save nahi kiya.', tts: 'ٹھیک ہے، کچھ محفوظ نہیں کیا۔' },
    ur: { text: 'ٹھیک ہے، کچھ محفوظ نہیں کیا۔', tts: 'ٹھیک ہے، کچھ محفوظ نہیں کیا۔' },
  },
  goAhead: {
    en: { text: 'Go ahead.', tts: 'Go ahead.' },
    'ur-Latn': { text: 'Boliye.', tts: 'بولیے۔' },
    ur: { text: 'بولیے۔', tts: 'بولیے۔' },
  },
  bye: {
    en: { text: 'Okay. Good luck with your sessions.', tts: 'Okay. Good luck with your sessions.' },
    'ur-Latn': { text: 'Theek hai. Allah Hafiz.', tts: 'ٹھیک ہے۔ اللہ حافظ۔' },
    ur: { text: 'ٹھیک ہے۔ اللہ حافظ۔', tts: 'ٹھیک ہے۔ اللہ حافظ۔' },
  },
};

export const line = (key: LineKey, language: ReplyLanguage): Line => LINES[key][language] ?? LINES[key].en;

/** Lines read one after another. */
export function joinLines(...lines: (Line | null | undefined)[]): Line {
  const parts = lines.filter((l): l is Line => Boolean(l && (l.text || l.tts)));
  return { text: parts.map((l) => l.text).join(' '), tts: parts.map((l) => l.tts || l.text).join(' ') };
}

const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * After a plan comes back: the reply, plus the question that moves things on, and what
 * to listen for. A question card or a clash comes first; ready changes are confirmed;
 * an answer with nothing to change asks if there is anything else.
 */
export function nextTurn(plan: AssistantPlan, mutating: string[]): { say: Line; listen: Listen } {
  const reply: Line = { text: plan.reply_text, tts: plan.reply_tts || plan.reply_text };
  const lang = plan.reply_language;
  const question = plan.actions.find((a) => a.status === 'needs_answer');
  if (question) {
    const q = question.question ?? '';
    const asked = q && !normal(plan.reply_text).includes(normal(q)) ? { text: q, tts: q } : null;
    return { say: joinLines(reply, asked), listen: { kind: 'answer', index: question.index } };
  }
  const clash = plan.actions.find((a) => a.status === 'clash' && mutating.includes(a.type));
  if (clash) return { say: joinLines(reply, line('when', lang)), listen: { kind: 'answer', index: clash.index } };
  if (plan.auto_applied) return { say: joinLines(reply, line('more', lang)), listen: { kind: 'more' } };
  const ready = plan.actions.filter((a) => a.status === 'ok' && mutating.includes(a.type)).length;
  if (ready) return { say: joinLines(reply, line(ready === 1 ? 'confirmOne' : 'confirmMany', lang)), listen: { kind: 'confirm' } };
  return { say: joinLines(reply, line('more', lang)), listen: { kind: 'more' } };
}

// Short answers. Each phrase is matched as whole words; an answer is a run of them
// ("haan theek hai kar do", "no thanks", "nahi rehne do").
const YES = [
  'yes', 'yeah', 'yea', 'yep', 'yup', 'sure', 'ok', 'okay', 'okey', 'alright', 'all right', 'right', 'correct', 'fine',
  'good', 'great', 'perfect', 'sounds good', 'go ahead', 'do it', 'save', 'save it', 'save them', 'save all', 'apply',
  'apply it', 'confirm', 'please do',
  'haan', 'han', 'haa', 'haanji', 'hanji', 'theek', 'thik', 'theek hai', 'thik hai', 'teek hai',
  'sahi', 'sahi hai', 'bilkul', 'zaroor', 'zarur', 'kar do', 'kardo', 'kar dein', 'kar den', 'kar dijiye', 'kar dijie',
  'save kar do', 'save kardo', 'save kar dein', 'chalo', 'acha', 'achha', 'accha', 'acha hai',
  'ہاں', 'جی ہاں', 'ٹھیک', 'ٹھیک ہے', 'صحیح', 'صحیح ہے', 'بالکل', 'ضرور', 'کر دو', 'کر دیں', 'کر دیجیے',
  'محفوظ کر دو', 'محفوظ کر دیں', 'اچھا', 'چلو',
];
const NO = [
  'no', 'nope', 'nah', 'not now', 'dont', 'don t', 'do not', 'cancel', 'cancel it', 'stop', 'never mind', 'nevermind',
  'leave it', 'skip', 'skip it', 'nothing', 'nothing else', 'no more',
  'nahi', 'nahin', 'nai', 'na', 'naa', 'mat', 'mat karo', 'mat karna', 'mat karein', 'rehne do', 'rehnay do',
  'rehne dein', 'chhodo', 'chodo', 'chhor do', 'chor do', 'cancel karo', 'cancel kar do', 'bas', 'bus', 'bas karo',
  'kuch nahi', 'aur kuch nahi', 'koi nahi',
  'نہیں', 'نہ', 'مت', 'مت کرو', 'رہنے دو', 'رہنے دیں', 'چھوڑ دو', 'چھوڑیں', 'بس', 'کچھ نہیں', 'اور کچھ نہیں',
];
const ENOUGH = [
  'thanks', 'thank you', 'thank u', 'thats all', 'that s all', 'that is all', 'thats it', 'that s it', 'done', 'all done',
  'im done', 'i m done', 'bye', 'goodbye', 'good bye', 'shukriya', 'shukria', 'meherbani', 'ho gaya', 'hogaya',
  'itna hi', 'bas itna hi', 'allah hafiz', 'khuda hafiz', 'khudahafiz',
  'شکریہ', 'مہربانی', 'ہو گیا', 'بس اتنا ہی', 'اللہ حافظ', 'خدا حافظ',
];
// Polite words that lean neither way ("nahi ji", "yes please"); alone they mean yes ("ji").
const FILLER = ['ji', 'jee', 'je', 'please', 'plz', 'pls', 'sir', 'bhai', 'yaar', 'جی'];
const PHRASES = [
  ...YES.map((p) => ({ words: p.split(' '), kind: 'yes' as const })),
  ...NO.map((p) => ({ words: p.split(' '), kind: 'no' as const })),
  ...ENOUGH.map((p) => ({ words: p.split(' '), kind: 'enough' as const })),
  ...FILLER.map((p) => ({ words: [p], kind: 'filler' as const })),
].sort((a, b) => b.words.length - a.words.length);

/**
 * "yes" / "no" / "enough" (thanks, that's all) when the whole utterance is a short
 * answer, else null (it's a request in its own right, e.g. "no, make it 8 pm").
 */
export function shortAnswer(text: string): 'yes' | 'no' | 'enough' | null {
  const words = normal(text).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 8) return null;
  const kinds = new Set<'yes' | 'no' | 'enough' | 'filler'>();
  for (let i = 0; i < words.length; ) {
    const hit = PHRASES.find((p) => p.words.every((w, j) => words[i + j] === w));
    if (!hit) return null;
    kinds.add(hit.kind);
    i += hit.words.length;
  }
  if (kinds.has('yes') && kinds.has('no')) return null;
  if (kinds.has('no')) return 'no';
  if (kinds.has('yes')) return 'yes';
  return kinds.has('enough') ? 'enough' : 'yes';
}
