// [20] Listening · [21] Review changes · [22] Saved with undo.
// Speech → AssemblyAI → plan (LLM) → every action checked → you apply → 10 s undo.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createAudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, useAnimatedProps, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { ApiError, errorMessage } from '@/lib/http';
import { useDraw, usePulse, useRise } from '@/lib/motion';
import { STATE_KEY, useLoadedState } from '@/lib/queries';
import { DarkTheme, fonts, palette, radius, screenPadding, useTheme } from '@/lib/theme';
import type { AssistantAction, AssistantPlan } from '@/lib/types';
import { useVoice } from '@/lib/voice';
import { Button, Chip, DeepWorkMark, Icon, type IconName, IconButton, T, TopBar, UndoToast } from '@/ui';

type Phase = 'listening' | 'thinking' | 'review' | 'saved';
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const MUTATING = ['add_commitment', 'add_session', 'move_session', 'cancel_session', 'delete_commitment', 'update_rule'];
const dk = palette.dark;

// ───────────────────────── listening
function Bars({ level, active }: { level: number; active: boolean }) {
  const [history, setHistory] = useState<number[]>(() => Array(14).fill(0.15));
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setHistory((h) => [...h.slice(1), Math.max(0.12, Math.min(1, levelRef.current * (0.75 + Math.random() * 0.5)))]);
    }, 90);
    return () => clearInterval(t);
  }, [active]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 44 }} accessibilityElementsHidden>
      {history.map((v, i) => (
        <View key={i} style={{ width: 4, height: 6 + v * 38, borderRadius: 2, backgroundColor: dk.mark, opacity: active ? 1 : 0.4 }} />
      ))}
    </View>
  );
}

function PulseRing({ delay }: { delay: number }) {
  const p = usePulse(1800 + delay);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 1 + p.value * 0.45 }], opacity: 0.35 * (1 - p.value) }));
  return <Animated.View style={[{ position: 'absolute', width: 88, height: 88, borderRadius: 44, backgroundColor: dk.mark }, style]} />;
}

function Blink() {
  const p = usePulse(700);
  const style = useAnimatedStyle(() => ({ opacity: 1 - p.value * 0.8 }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: dk.mark }, style]} />;
}

function Listening({
  onText,
  typingFirst,
  credit,
  initialError,
}: {
  onText: (text: string, meta: { confidence?: number | null; language?: string | null }) => void;
  typingFirst: boolean;
  credit: string;
  initialError?: string | null;
}) {
  const insets = useSafeAreaInsets();
  const [typing, setTyping] = useState(typingFirst);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const finish = useCallback(
    (t: { text: string; confidence: number | null; language: string | null } | null) => {
      if (t?.text) onText(t.text, { confidence: t.confidence, language: t.language });
      else setError("I didn't catch anything. Try again, or type it.");
    },
    [onText],
  );
  const voice = useVoice(finish);

  useEffect(() => {
    if (typing) return;
    voice.start().catch((err) => {
      setError(errorMessage(err));
      setTyping(true);
    });
    return () => {
      voice.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);

  const stop = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    try {
      finish(await voice.stop());
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: dk.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16, paddingHorizontal: screenPadding }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <IconButton icon="x" label="Close" tone="dark" onPress={() => router.back()} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#1F1E1D', borderRadius: 999, paddingHorizontal: 14, minHeight: 34 }}>
            {voice.phase === 'recording' ? <Blink /> : null}
            <T variant="label" color={dk.text}>
              {typing ? 'Type it' : voice.phase === 'transcribing' ? 'Writing it down' : 'Listening'}
            </T>
          </View>
          <IconButton
            icon={typing ? 'mic' : 'keyboard'}
            label={typing ? 'Speak instead' : 'Type instead'}
            tone="dark"
            onPress={() => {
              setError(null);
              if (!typing) voice.cancel();
              setTyping(!typing);
            }}
          />
        </View>

        <T variant="body" color={dk.textSecondary} style={{ marginTop: 56 }}>
          Tell me what changed in your week. I'll check everything for clashes before anything is saved.
        </T>

        {typing ? (
          <View style={{ flex: 1, marginTop: 20 }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="e.g. kal shaam 7 baje gym add kar do"
              placeholderTextColor={dk.textMuted}
              multiline
              autoFocus
              style={{ color: dk.text, fontFamily: fonts.display, fontSize: 28, lineHeight: 36, flex: 1, textAlignVertical: 'top' }}
            />
            <Button label="Check my week" iconRight="arrowRight" disabled={!draft.trim()} onPress={() => onText(draft.trim(), {})} />
          </View>
        ) : (
          <View style={{ flex: 1, justifyContent: 'space-between', marginTop: 20 }}>
            <T style={{ fontFamily: fonts.display, fontSize: 30, lineHeight: 40, color: voice.phase === 'recording' ? dk.textMuted : dk.text }}>
              {voice.phase === 'transcribing' ? 'Writing it down…' : voice.phase === 'recording' ? 'Go ahead, I’m listening' : ''}
              {voice.phase === 'recording' ? <T style={{ color: dk.mark, fontFamily: fonts.display, fontSize: 30 }}>|</T> : null}
            </T>
            <View style={{ alignItems: 'center', gap: 18 }}>
              <Bars level={voice.level} active={voice.phase === 'recording'} />
              <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
                {voice.phase === 'recording' ? (
                  <>
                    <PulseRing delay={0} />
                    <PulseRing delay={600} />
                  </>
                ) : null}
                <Pressable
                  onPress={stop}
                  disabled={voice.phase !== 'recording'}
                  accessibilityRole="button"
                  accessibilityLabel="Stop and check"
                  style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: dk.mark, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="stop" size={28} color="#FAF9F5" />
                </Pressable>
              </View>
              <T variant="label" color={dk.text}>
                {voice.phase === 'recording' ? "Tap when you're done" : voice.phase === 'transcribing' ? 'One moment…' : ' '}
              </T>
            </View>
          </View>
        )}
        {error ? (
          <T variant="bodySm" color={dk.danger} style={{ marginTop: 12 }} accessibilityLiveRegion="polite">
            {error}
          </T>
        ) : null}
        <T variant="caption" color={dk.textMuted} align="center" style={{ marginTop: 14 }}>
          {credit}
        </T>
      </View>
    </KeyboardAvoidingView>
  );
}

// ───────────────────────── review
const ICONS: Record<string, IconName> = {
  add_commitment: 'plus',
  add_session: 'plus',
  move_session: 'arrowRight',
  cancel_session: 'x',
  delete_commitment: 'trash',
  update_rule: 'retry',
  clarify: 'question',
  none: 'check',
};

function ActionCard({ a, index, onAnswer, busy }: { a: AssistantAction; index: number; onAnswer: (index: number, answer: string) => void; busy: boolean }) {
  const { c } = useTheme();
  const rise = useRise(index + 1);
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const question = a.status === 'needs_answer';
  const clash = a.status === 'clash';
  const ok = a.status === 'ok';
  const tile = question ? c.button : c.sand;
  return (
    <Animated.View style={rise}>
      <View
        style={{
          borderRadius: radius.card,
          borderWidth: question || clash ? 1.5 : 1,
          borderColor: question ? c.button : clash ? c.danger : c.line,
          backgroundColor: c.surface,
          padding: 14,
          gap: 10,
          opacity: a.status === 'invalid' ? 0.7 : 1,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: tile, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={clash ? 'alert' : ICONS[a.type] ?? 'check'} size={20} color={question ? '#FAF9F5' : clash ? c.danger : c.text} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <T variant="label" style={{ fontSize: 16, flex: 1 }}>
                {question ? a.question ?? a.summary : a.summary}
              </T>
              {a.when && a.type !== 'move_session' && !question ? (
                <T variant="caption" style={{ fontFamily: fonts.monoMedium, maxWidth: 150 }} align="right">
                  {a.when}
                </T>
              ) : null}
            </View>
            {a.type === 'move_session' && a.when ? (
              <T variant="caption" style={{ fontFamily: fonts.monoMedium }}>
                {a.when}
              </T>
            ) : null}
            {ok && a.note ? (
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <Icon name="check" size={14} color={c.success} />
                <T variant="caption" tone="secondary" style={{ flex: 1 }}>
                  {a.note}
                </T>
              </View>
            ) : null}
            {clash && a.note ? (
              <T variant="caption" tone="danger">
                {a.note}
              </T>
            ) : null}
            {a.status === 'invalid' && a.note ? (
              <T variant="caption" tone="secondary">
                {a.note}
              </T>
            ) : null}
          </View>
        </View>
        {question || clash ? (
          <View style={{ gap: 8 }}>
            {question ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {(a.options ?? []).map((o) => (
                  <Chip key={o} label={o} mono={/^\d|^[A-Z][a-z]{2} \d/.test(o)} disabled={busy} onPress={() => onAnswer(a.index, o)} />
                ))}
                <Chip label="Other" tone="outline" disabled={busy} onPress={() => setOther(true)} />
              </View>
            ) : (
              <Button label="Pick another time" variant="link" style={{ alignSelf: 'flex-start' }} onPress={() => setOther(true)} />
            )}
            {other ? (
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  autoFocus
                  placeholder={clash ? 'When instead? e.g. Friday 6 pm' : 'Your answer'}
                  placeholderTextColor={c.textMuted}
                  onSubmitEditing={() => text.trim() && onAnswer(a.index, text.trim())}
                  style={{ flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 12, color: c.text, fontFamily: fonts.ui, fontSize: 15 }}
                />
                <IconButton icon="arrowRight" label="Send answer" tone="kiln" onPress={() => text.trim() && onAnswer(a.index, text.trim())} />
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

function Review({
  plan,
  busy,
  onAnswer,
  onApply,
  onBack,
}: {
  plan: AssistantPlan;
  busy: 'answer' | 'apply' | null;
  onAnswer: (index: number, answer: string) => void;
  onApply: () => void;
  onBack: () => void;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const changes = plan.actions.filter((a) => MUTATING.includes(a.type) || a.status === 'needs_answer');
  const ok = plan.actions.filter((a) => a.status === 'ok' && MUTATING.includes(a.type)).length;
  const all = changes.length > 0 && ok === changes.length;
  const onlyInfo = changes.length === 0;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: screenPadding, paddingBottom: 24, gap: 14 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <IconButton icon="chevronLeft" label="Back" onPress={onBack} />
          <T variant="label" align="center" style={{ flex: 1, fontSize: 16, marginRight: 44 }}>
            Review changes
          </T>
        </View>
        <T style={{ fontFamily: fonts.displayItalic, fontSize: 19, lineHeight: 27, color: c.textSecondary }}>{`“${plan.transcript.split('\n')[0]}”`}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <DeepWorkMark size={22} />
          <T variant="h2">
            {onlyInfo ? 'Here’s what I found' : `I found ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </T>
        </View>
        {plan.reply_text ? <T tone="secondary">{plan.reply_text}</T> : null}
        {plan.actions
          .filter((a) => a.type !== 'none')
          .map((a, i) => (
            <ActionCard key={`${a.index}-${a.summary}`} a={a} index={i} busy={busy !== null} onAnswer={onAnswer} />
          ))}
      </ScrollView>
      <View style={{ paddingHorizontal: screenPadding, paddingBottom: insets.bottom + 12, gap: 8 }}>
        {onlyInfo ? (
          <Button label="Done" onPress={() => router.back()} />
        ) : (
          <Button
            label={busy === 'answer' ? 'Checking…' : ok === 0 ? 'Nothing to apply yet' : all && ok > 1 ? `Apply all ${ok} changes` : `Apply ${ok} change${ok === 1 ? '' : 's'}`}
            disabled={ok === 0 || busy !== null}
            loading={busy === 'apply'}
            onPress={onApply}
          />
        )}
        <T variant="caption" tone="secondary" align="center">
          Nothing is saved until you tap Apply. Undo for 10 seconds after.
        </T>
      </View>
    </View>
  );
}

// ───────────────────────── saved
function DoneMark() {
  const { c } = useTheme();
  const p = useDraw(700);
  const tick = useDraw(360, 600);
  const circ = 2 * Math.PI * 24;
  const ring = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - p.value) }));
  const check = useAnimatedProps(() => ({ strokeDashoffset: 24 * (1 - tick.value) }));
  return (
    <Svg width={56} height={56} viewBox="0 0 56 56">
      <AnimatedCircle cx={28} cy={28} r={24} stroke={c.success} strokeWidth={4} fill="none" strokeDasharray={`${circ} ${circ}`} animatedProps={ring} transform="rotate(-90 28 28)" />
      <AnimatedPath d="M17 29l7 7 15-15" stroke={c.success} strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" fill="none" strokeDasharray="24 24" animatedProps={check} />
    </Svg>
  );
}

function splitLabel(label: string): [string, string] {
  const m = /^(.*?)\s((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?: \d{1,2} [A-Z][a-z]{2})?(?: \d{2}:\d{2})?)$/.exec(label);
  return m ? [m[1], m[2]] : [label, ''];
}

function Saved({
  plan,
  appliedIndexes,
  undoUntil,
  onUndo,
  onNext,
}: {
  plan: AssistantPlan;
  appliedIndexes: number[];
  undoUntil: number;
  onUndo: () => void;
  onNext: (text: string | null) => void;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [showUndo, setShowUndo] = useState(undoUntil > Date.now());
  const [text, setText] = useState('');
  const applied = plan.actions.filter((a) => appliedIndexes.includes(a.index));
  const left = Math.max(1000, undoUntil - Date.now() - 2000);
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: screenPadding, gap: 18, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <TopBar title="Assistant" onBack={() => router.back()} />
        <Animated.View entering={FadeIn.duration(250)} style={{ gap: 16 }}>
          <DoneMark />
          <T variant="h1">Done. Your week still has no overlaps.</T>
          <View style={{ borderRadius: radius.card, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
            {applied.map((a, i) => {
              const [left_, right] = splitLabel(a.done_label ?? a.summary);
              return (
                <View key={a.index} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
                  <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: a.type === 'add_commitment' ? c.lineStrong : c.mark }} />
                  <T variant="bodySm" style={{ flex: 1 }}>
                    {left_}
                  </T>
                  <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono }}>
                    {right}
                  </T>
                </View>
              );
            })}
          </View>
          <Button label="See my week" iconRight="arrowRight" variant="link" style={{ alignSelf: 'flex-start' }} onPress={() => router.replace('/schedule')} />
        </Animated.View>
      </ScrollView>
      <View style={{ paddingHorizontal: screenPadding, paddingBottom: insets.bottom + 12, gap: 10 }}>
        {showUndo ? (
          <UndoToast
            message={`${applied.length} change${applied.length === 1 ? '' : 's'} saved`}
            duration={left}
            onAction={() => {
              setShowUndo(false);
              onUndo();
            }}
            onDone={() => setShowUndo(false)}
          />
        ) : null}
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Type a change, or hold the mic"
            placeholderTextColor={c.textMuted}
            onSubmitEditing={() => text.trim() && onNext(text.trim())}
            style={{ flex: 1, minHeight: 52, borderRadius: radius.input, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface, paddingHorizontal: 16, color: c.text, fontFamily: fonts.ui, fontSize: 15 }}
          />
          <IconButton icon={text.trim() ? 'arrowRight' : 'mic'} label={text.trim() ? 'Send' : 'Speak'} tone="kiln" size={52} onPress={() => onNext(text.trim() || null)} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ───────────────────────── screen
export default function Assistant() {
  const state = useLoadedState();
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 10 * 60_000 });
  const [phase, setPhase] = useState<Phase>('listening');
  const [plan, setPlan] = useState<AssistantPlan | null>(null);
  const [busy, setBusy] = useState<'answer' | 'apply' | null>(null);
  const [applied, setApplied] = useState<{ indexes: number[]; until: number } | null>(null);
  const [listenKey, setListenKey] = useState(0);
  const [startTyping, setStartTyping] = useState(false);
  const [listenError, setListenError] = useState<string | null>(null);
  const player = useRef<ReturnType<typeof createAudioPlayer> | null>(null);

  useEffect(() => () => player.current?.remove(), []);

  const speak = async (p: AssistantPlan) => {
    if (!state.profile.speak_replies || !p.reply_tts || health.data?.text_to_speech.configured === false) return;
    try {
      player.current?.remove();
      player.current = createAudioPlayer(await api.speechSource(p.reply_tts, p.reply_language));
      player.current.play();
    } catch {
      // the reply is on screen anyway
    }
  };

  const handlePlan = async (p: AssistantPlan) => {
    setPlan(p);
    await qc.invalidateQueries({ queryKey: STATE_KEY });
    if (p.auto_applied && p.applied) {
      setApplied({ indexes: p.applied.applied.map((x) => x.index), until: new Date(p.applied.undo_until).getTime() });
      setPhase('saved');
    } else {
      setPhase('review');
    }
    speak(p);
  };

  const ask = async (text: string, meta: { confidence?: number | null; language?: string | null }) => {
    setPhase('thinking');
    try {
      await handlePlan(await api.plan(text, meta));
    } catch (err) {
      setListenError(err instanceof ApiError && err.code === 'ai_not_configured' ? 'The assistant isn’t set up on the server yet (its AI key is missing).' : errorMessage(err));
      setStartTyping(true);
      setListenKey((k) => k + 1);
      setPhase('listening');
    }
  };

  const answer = async (index: number, value: string) => {
    if (!plan) return;
    setBusy('answer');
    try {
      const next = await api.answer(plan.run_id, index, value);
      setPlan(next);
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!plan) return;
    const indexes = plan.actions.filter((a) => a.status === 'ok' && MUTATING.includes(a.type)).map((a) => a.index);
    setBusy('apply');
    try {
      const r = await api.apply(plan.run_id, indexes);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setApplied({ indexes: r.applied.map((x) => x.index), until: new Date(r.undo_until).getTime() });
      await qc.invalidateQueries({ queryKey: STATE_KEY });
      setPhase('saved');
    } catch (err) {
      showBanner(err instanceof ApiError && err.code === 'clash' ? 'Something changed meanwhile and a time is taken now. Nothing was saved.' : errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (!plan) return;
    try {
      await api.undo(plan.run_id);
      await qc.invalidateQueries({ queryKey: STATE_KEY });
      showBanner('Undone. Your week is back as it was.');
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
    }
  };

  const credit = health.data
    ? `Speech to text by ${health.data.speech_to_text.provider} · Planning by ${health.data.llm.provider}`
    : 'Speech to text by AssemblyAI · Planning by Groq';

  if (phase === 'listening' || phase === 'thinking') {
    return (
      <DarkTheme>
        {phase === 'thinking' ? (
          <View style={{ flex: 1, backgroundColor: dk.bg, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
            <DeepWorkMark size={64} color={dk.mark} animated />
            <T color={dk.text}>Checking your week…</T>
          </View>
        ) : (
          <Listening
            key={listenKey}
            typingFirst={startTyping || health.data?.speech_to_text.configured === false}
            credit={credit}
            initialError={listenError ?? (health.data?.speech_to_text.configured === false ? 'Voice isn’t set up on the server yet, so type instead.' : null)}
            onText={ask}
          />
        )}
      </DarkTheme>
    );
  }
  if (phase === 'review' && plan) {
    return (
      <Review
        plan={plan}
        busy={busy}
        onAnswer={answer}
        onApply={apply}
        onBack={() => {
          setListenKey((k) => k + 1);
          setPhase('listening');
        }}
      />
    );
  }
  if (phase === 'saved' && plan && applied) {
    return (
      <Saved
        plan={plan}
        appliedIndexes={applied.indexes}
        undoUntil={applied.until}
        onUndo={undo}
        onNext={(text) => {
          if (text) ask(text, {});
          else {
            setStartTyping(false);
            setListenError(null);
            setListenKey((k) => k + 1);
            setPhase('listening');
          }
        }}
      />
    );
  }
  return null;
}
