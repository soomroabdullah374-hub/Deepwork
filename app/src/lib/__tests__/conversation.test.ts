import { describe, expect, it } from '@jest/globals';
import { joinLines, line, nextTurn, shortAnswer } from '../conversation';
import type { AssistantAction, AssistantPlan } from '../types';

const MUTATING = ['add_commitment', 'add_session', 'move_session', 'cancel_session', 'delete_commitment', 'update_rule'];

const action = (a: Partial<AssistantAction>): AssistantAction => ({ index: 0, type: 'add_commitment', status: 'ok', summary: 'Add gym', ...a });
const plan = (actions: AssistantAction[], p: Partial<AssistantPlan> = {}): AssistantPlan => ({
  run_id: 'r1',
  transcript: 'x',
  reply_language: 'en',
  reply_text: 'Gym fits tomorrow at 7 pm.',
  reply_tts: 'Gym fits tomorrow at 7 pm.',
  actions,
  ready: 0,
  ...p,
});

describe('short spoken answers', () => {
  it.each([
    'Yes', 'yeah sure', 'ok', 'Okay, save it.', 'yes please', 'haan', 'haan ji', 'ji', 'jee haan', 'theek hai',
    'haan theek hai kar do', 'bilkul', 'save kar do', 'acha', 'ہاں', 'جی ہاں', 'ٹھیک ہے، کر دو', 'جی', 'please',
  ])('"%s" is yes', (text) => {
    expect(shortAnswer(text)).toBe('yes');
  });

  it.each(['no', 'No thanks.', 'nahi', 'nahi ji', 'nahin rehne do', 'cancel', 'mat karo', "don't", 'bas', 'نہیں', 'رہنے دو', 'nothing else'])(
    '"%s" is no',
    (text) => {
      expect(shortAnswer(text)).toBe('no');
    },
  );

  it.each(["that's all", 'thanks', 'shukriya', 'ho gaya', 'شکریہ', "I'm done"])('"%s" is enough', (text) => {
    expect(shortAnswer(text)).toBe('enough');
  });

  it.each(['', 'add gym tomorrow at 7', 'no, make it 8 pm', 'yes and also add swimming', "what's on tomorrow", 'haan nahi'])(
    '"%s" is not a short answer',
    (text) => {
      expect(shortAnswer(text)).toBeNull();
    },
  );
});

describe('what the assistant says next', () => {
  it('asks to save ready changes', () => {
    const t = nextTurn(plan([action({})]), MUTATING);
    expect(t.listen).toEqual({ kind: 'confirm' });
    expect(t.say.text).toBe('Gym fits tomorrow at 7 pm. Shall I save it?');
    expect(nextTurn(plan([action({}), action({ index: 1 })]), MUTATING).say.text).toMatch(/Shall I save these\?$/);
  });

  it('answers a question card first, adding the question when the reply lacks it', () => {
    const t = nextTurn(plan([action({}), action({ index: 1, status: 'needs_answer', question: 'Which goal is this session for?' })]), MUTATING);
    expect(t.listen).toEqual({ kind: 'answer', index: 1 });
    expect(t.say.text).toBe('Gym fits tomorrow at 7 pm. Which goal is this session for?');
    const asked = nextTurn(plan([action({ status: 'needs_answer', question: 'Which goal?' })], { reply_text: 'Sure. Which goal?' }), MUTATING);
    expect(asked.say.text).toBe('Sure. Which goal?');
  });

  it('asks for another time when something clashes', () => {
    const t = nextTurn(plan([action({ status: 'clash' })], { reply_language: 'ur-Latn', reply_text: 'Yeh waqt busy hai.', reply_tts: 'یہ وقت مصروف ہے۔' }), MUTATING);
    expect(t.listen).toEqual({ kind: 'answer', index: 0 });
    expect(t.say).toEqual({ text: 'Yeh waqt busy hai. Kis waqt rakhoon?', tts: 'یہ وقت مصروف ہے۔ کس وقت رکھوں؟' });
  });

  it('asks if there is anything else after an answer or an auto-applied change', () => {
    expect(nextTurn(plan([action({ type: 'none', status: 'info' })]), MUTATING)).toEqual({
      say: { text: 'Gym fits tomorrow at 7 pm. Anything else?', tts: 'Gym fits tomorrow at 7 pm. Anything else?' },
      listen: { kind: 'more' },
    });
    expect(nextTurn(plan([action({})], { auto_applied: true }), MUTATING).listen).toEqual({ kind: 'more' });
  });

  it('joins lines and speaks Urdu for Roman Urdu', () => {
    expect(joinLines(line('done', 'ur-Latn'), line('more', 'ur-Latn'))).toEqual({ text: 'Ho gaya. Aur kuch?', tts: 'ہو گیا۔ اور کچھ؟' });
  });
});
