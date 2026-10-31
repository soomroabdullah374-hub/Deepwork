// [20] Listening · [21] Review changes · [22] Saved with undo — as a live conversation.
// Speech → AssemblyAI → plan (LLM) → every action checked → you apply → 10 s undo.
// In voice mode the assistant speaks its reply and listens again on its own: you answer
// its questions, give another time for a clash, and say "yes" to save or "no" to leave
// it. Recording ends when you pause. Any tap takes over from the voice.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, useAnimatedProps, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { joinLines, type Line, line, type Listen, nextTurn, type ReplyLanguage, shortAnswer } from '@/lib/conversation';
import { ApiError, errorMessage } from '@/lib/http';
import { useDraw, usePulse, useRise } from '@/lib/motion';
import { STATE_KEY, useLoadedState } from '@/lib/queries';
import { DarkTheme, fonts, palette, radius, screenPadding, useTheme } from '@/lib/theme';
import type { AssistantAction, AssistantPlan, Transcript } from '@/lib/types';
import { type AutoStop, useVoice } from '@/lib/voice';
import { speakReply, stopReply } from '@/lib/voiceReply';
import { Button, Chip, DeepWorkMark, Icon, type IconName, IconButton, T, TopBar, UndoToast } from '@/ui';

type Phase = 'listening' | 'thinking' | 'review' | 'saved';
/** What the voice is doing on the Review and Saved screens. */
type Turn = 'idle' | 'speaking' | 'listening' | 'thinking';
type Voice = ReturnType<typeof useVoice>;
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const MUTATING = ['add_commitment', 'add_session', 'move_session', 'cancel_session', 'delete_commitment', 'update_rule'];
const dk = palette.dark;
const INK = '#30302E';
const IVORY = '#FAF9F5';
const KILN = '#D97757';

// ───────────────────────── listening
function Bars({ level, active, count = 14, height = 44, color = dk.mark }: { level: number; active: boolean; count?: number; height?: number; color?: string }) {
  const [history, setHistory] = useState<number[]>(() => Array(count).fill(0.15));
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
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: height > 30 ? 5 : 3, height }} accessibilityElementsHidden>
      {history.map((v, i) => (
        <View key={i} style={{ width: height > 30 ? 4 : 3, height: 4 + v * (height - 6), borderRadius: 2, backgroundColor: color, opacity: active ? 1 : 0.4 }} />
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
  voice,
  typing,
  onTyping,
  error,
  onStart,
  onStop,
  onText,
  credit,
}: {
  voice: Voice;
  typing: boolean;
  onTyping: (typing: boolean) => void;
  error: string | null;
  /** Start recording a request (also on arrival). */
  onStart: () => void;
  /** The stop button: send what was said now. */
  onStop: () => void;
  onText: (text: string) => void;
  credit: string;
}) {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (typing) return;
    onStart();
    return () => {
      voice.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);

  const recording = voice.phase === 'recording';
  const press = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    if (recording) onStop();
    else if (voice.phase === 'idle') onStart();
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: dk.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16, paddingHorizontal: screenPadding }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <IconButton icon="x" label="Close" tone="dark" onPress={() => router.back()} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#1F1E1D', borderRadius: 999, paddingHorizontal: 14, minHeight: 34 }}>
            {recording ? <Blink /> : null}
            <T variant="label" color={dk.text}>
              {typing ? 'Type it' : voice.phase === 'transcribing' ? 'Writing it down' : recording ? 'Listening' : 'Voice'}
            </T>
          </View>
          <IconButton icon={typing ? 'mic' : 'keyboard'} label={typing ? 'Speak instead' : 'Type instead'} tone="dark" onPress={() => onTyping(!typing)} />
        </View>

        <T variant="body" color={dk.textSecondary} style={{ marginTop: 56 }}>
          {typing
            ? "Tell me what changed in your week. I'll check everything for clashes before anything is saved."
            : "Tell me what changed in your week, and pause when you're done. I'll ask if anything is unclear, and nothing is saved until you say yes."}
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
            <Button label="Check my week" iconRight="arrowRight" disabled={!draft.trim()} onPress={() => onText(draft.trim())} />
          </View>
        ) : (
          <View style={{ flex: 1, justifyContent: 'space-between', marginTop: 20 }}>
            <T style={{ fontFamily: fonts.display, fontSize: 30, lineHeight: 40, color: recording ? dk.textMuted : dk.text }}>
              {voice.phase === 'transcribing' ? 'Writing it down…' : recording ? 'Go ahead, I’m listening' : ''}
              {recording ? <T style={{ color: dk.mark, fontFamily: fonts.display, fontSize: 30 }}>|</T> : null}
            </T>
            <View style={{ alignItems: 'center', gap: 18 }}>
              <Bars level={voice.level} active={recording} />
              <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
                {recording ? (
                  <>
                    <PulseRing delay={0} />
                    <PulseRing delay={600} />
                  </>
                ) : null}
                <Pressable
                  onPress={press}
                  disabled={voice.phase === 'transcribing'}
                  accessibilityRole="button"
                  accessibilityLabel={recording ? 'Done, check it now' : 'Talk'}
                  style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: dk.mark, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name={recording ? 'stop' : 'mic'} size={28} color={IVORY} />
                </Pressable>
              </View>
              <T variant="label" color={dk.text}>
                {recording ? 'I’ll check it when you pause' : voice.phase === 'transcribing' ? 'One moment…' : 'Tap to talk'}
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

// ───────────────────────── the voice, on Review and Saved
interface VoiceControls {
  /** Voice mode: it listens again after speaking. */
  live: boolean;
  onSkip: () => void;
  onSendNow: () => void;
  onEnd: () => void;
}

function VoiceBar({ turn, level, live, onSkip, onSendNow, onEnd }: { turn: Turn; level: number } & VoiceControls) {
  if (turn === 'idle') return null;
  const label = turn === 'listening' ? 'Listening…' : turn === 'speaking' ? 'Speaking…' : 'Checking…';
  const hint = turn === 'listening' ? 'Pause when you’re done' : turn === 'speaking' && live ? 'Then I’ll listen' : null;
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, borderRadius: 999, backgroundColor: INK, paddingLeft: 20, paddingRight: 8 }}
    >
      {turn === 'listening' ? (
        <Bars level={level} active count={7} height={26} color={KILN} />
      ) : turn === 'speaking' ? (
        <Icon name="speaker" size={20} color={KILN} />
      ) : (
        <ActivityIndicator color={KILN} />
      )}
      <View style={{ flex: 1 }}>
        <T variant="label" color={IVORY}>
          {label}
        </T>
        {hint ? (
          <T variant="caption" color="#B0AEA5">
            {hint}
          </T>
        ) : null}
      </View>
      {turn === 'listening' ? <IconButton icon="check" label="Done, check it now" tone="kiln" size={44} onPress={onSendNow} /> : null}
      {turn === 'speaking' ? <IconButton icon="mic" label="Talk now" tone="kiln" size={44} onPress={onSkip} /> : null}
      <IconButton icon="x" label="Stop the voice conversation" tone="dark" size={44} onPress={onEnd} />
    </Animated.View>
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
  turn,
  level,
  onAnswer,
  onApply,
  onBack,
  onTalk,
  voiceBar,
}: {
  plan: AssistantPlan;
  busy: 'answer' | 'apply' | null;
  turn: Turn;
  level: number;
  onAnswer: (index: number, answer: string) => void;
  onApply: () => void;
  onBack: () => void;
  onTalk: () => void;
  voiceBar: VoiceControls;
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
        <VoiceBar turn={turn} level={level} {...voiceBar} />
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          {turn === 'idle' ? <IconButton icon="mic" label="Answer by voice" tone="kiln" size={52} onPress={onTalk} /> : null}
          {onlyInfo ? (
            <Button label="Done" onPress={() => router.back()} style={{ flex: 1 }} />
          ) : (
            <Button
              label={busy === 'answer' ? 'Checking…' : ok === 0 ? 'Nothing to apply yet' : all && ok > 1 ? `Apply all ${ok} changes` : `Apply ${ok} change${ok === 1 ? '' : 's'}`}
              disabled={ok === 0 || busy !== null}
              loading={busy === 'apply'}
              onPress={onApply}
              style={{ flex: 1 }}
            />
          )}
        </View>
        <T variant="caption" tone="secondary" align="center">
          {turn !== 'idle' && voiceBar.live && !onlyInfo
            ? 'Say “yes” or tap Apply to save. Undo for 10 seconds after.'
            : 'Nothing is saved until you tap Apply. Undo for 10 seconds after.'}
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
  turn,
  level,
  onUndo,
  onNext,
  onTalk,
  voiceBar,
}: {
  plan: AssistantPlan;
  appliedIndexes: number[];
  undoUntil: number;
  turn: Turn;
  level: number;
  onUndo: () => void;
  onNext: (text: string) => void;
  onTalk: () => void;
  voiceBar: VoiceControls;
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
        {turn !== 'idle' ? (
          <VoiceBar turn={turn} level={level} {...voiceBar} />
        ) : (
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Type a change, or tap the mic"
              placeholderTextColor={c.textMuted}
              onSubmitEditing={() => text.trim() && onNext(text.trim())}
              style={{ flex: 1, minHeight: 52, borderRadius: radius.input, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface, paddingHorizontal: 16, color: c.text, fontFamily: fonts.ui, fontSize: 15 }}
            />
            <IconButton
              icon={text.trim() ? 'arrowRight' : 'mic'}
              label={text.trim() ? 'Send' : 'Talk'}
              tone="kiln"
              size={52}
              onPress={() => (text.trim() ? onNext(text.trim()) : onTalk())}
            />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ───────────────────────── screen
const replyLine = (p: AssistantPlan): Line => ({ text: p.reply_text, tts: p.reply_tts || p.reply_text });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function Assistant() {
  const state = useLoadedState();
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 10 * 60_000 });
  const [phase, setPhase] = useState<Phase>('listening');
  const [plan, setPlan] = useState<AssistantPlan | null>(null);
  const [busy, setBusy] = useState<'answer' | 'apply' | null>(null);
  const [applied, setApplied] = useState<{ indexes: number[]; until: number } | null>(null);
  const [listenKey, setListenKey] = useState(0);
  const [typing, setTyping] = useState(false);
  const [listenError, setListenError] = useState<string | null>(null);
  const [turn, setTurn] = useState<Turn>('idle');
  const [liveOn, setLiveOn] = useState(true);
  // Voice mode: after each reply, listen again on its own.
  const live = useRef(true);
  // Every step bumps this; a step that finds it changed was overtaken (by a tap) and stops.
  const turnId = useRef(0);
  // The step the current recording belongs to, and what its words are for.
  const listening = useRef<number | null>(null);
  const listenFor = useRef<Listen>({ kind: 'request' });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const planRef = useRef(plan);
  planRef.current = plan;
  const voice = useVoice({ endOnPause: true, onAutoStop: (t, why, error) => heard(t, why, error) });

  useEffect(
    () => () => {
      turnId.current += 1;
      stopReply();
    },
    [],
  );

  const sttOff = health.data?.speech_to_text.configured === false;
  // while the clip uploads, the bar says so
  const shownTurn: Turn = turn === 'listening' && voice.phase === 'transcribing' ? 'thinking' : turn;
  const lang: ReplyLanguage = plan?.reply_language ?? (state.profile.language === 'ur-Latn' ? 'ur-Latn' : 'en');

  const setLive = (on: boolean) => {
    live.current = on;
    setLiveOn(on);
  };

  /** A tap takes over: stop talking and listening. */
  const interrupt = () => {
    turnId.current += 1;
    listening.current = null;
    stopReply();
    voice.cancel();
    setTurn('idle');
  };

  const listenNow = async (next: Listen, id = ++turnId.current) => {
    listenFor.current = next;
    try {
      await voice.start();
      if (id !== turnId.current) {
        voice.cancel();
        return;
      }
      listening.current = id;
      setTurn('listening');
    } catch (err) {
      setLive(false);
      setTurn('idle');
      if (phaseRef.current === 'listening') {
        setListenError(errorMessage(err));
        setTyping(true);
      } else {
        showBanner(errorMessage(err), 'danger');
      }
    }
  };

  /** Say `say` (when replies are spoken), then in voice mode listen for `next`. */
  const converse = async (say: Line | null, language: ReplyLanguage, next: Listen | null) => {
    const id = ++turnId.current;
    listening.current = null;
    await voice.cancel();
    if (say?.text && state.profile.speak_replies) {
      setTurn('speaking');
      await speakReply({ text: say.text, tts: say.tts, language }).catch(() => undefined);
      if (id !== turnId.current) return;
    }
    if (!live.current || !next) {
      setTurn('idle');
      return;
    }
    await pause(400); // let the speaker go quiet before the mic opens
    if (id !== turnId.current) return;
    await listenNow(next, id);
  };

  /** What was said (from a pause, the time limit, or the Done button). */
  const heard = (t: Transcript | null, why: AutoStop | 'tap', error?: unknown) => {
    const id = listening.current;
    if (id === null || id !== turnId.current) return; // a tap took over meanwhile
    listening.current = null;
    setTurn('idle');
    if (error) {
      // the clip didn't reach the server or couldn't be read: say why
      if (phaseRef.current === 'listening') setListenError(errorMessage(error));
      else {
        setLive(false);
        showBanner(errorMessage(error), 'danger');
      }
      return;
    }
    const text = t?.text?.trim();
    if (!text) {
      if (phaseRef.current === 'listening') {
        setListenError(why === 'quiet' ? 'I didn’t hear anything. Tap the mic and try again, or type it.' : 'I didn’t catch that. Tap the mic and try again, or type it.');
      } else {
        setLive(false); // nothing said: the voice rests until you tap the mic
      }
      return;
    }
    const meta = { confidence: t?.confidence ?? null, language: t?.language ?? null };
    const target = listenFor.current;
    const language = planRef.current?.reply_language ?? lang;
    if (target.kind === 'request') return void ask(text, meta);
    if (target.kind === 'answer') return void answer(target.index, text);
    const short = shortAnswer(text);
    if (target.kind === 'confirm') {
      if (short === 'yes') return void apply();
      if (short === 'no') return void converse(joinLines(line('notSaved', language), line('more', language)), language, { kind: 'more' });
      return void ask(text, meta);
    }
    if (short === 'no' || short === 'enough') {
      setLive(false);
      return void converse(line('bye', language), language, null);
    }
    if (short === 'yes') return void converse(line('goAhead', language), language, { kind: 'request' });
    void ask(text, meta);
  };

  const handlePlan = async (p: AssistantPlan) => {
    setPlan(p);
    planRef.current = p;
    await qc.invalidateQueries({ queryKey: STATE_KEY });
    if (p.auto_applied && p.applied) {
      setApplied({ indexes: p.applied.applied.map((x) => x.index), until: new Date(p.applied.undo_until).getTime() });
      setPhase('saved');
    } else {
      setPhase('review');
    }
    const t = nextTurn(p, MUTATING);
    void converse(live.current ? t.say : replyLine(p), p.reply_language, t.listen);
  };

  const ask = async (text: string, meta: { confidence?: number | null; language?: string | null }) => {
    interrupt();
    setPhase('thinking');
    try {
      await handlePlan(await api.plan(text, meta));
    } catch (err) {
      setListenError(err instanceof ApiError && err.code === 'ai_not_configured' ? 'The assistant isn’t set up on the server yet (its AI key is missing).' : errorMessage(err));
      setLive(false);
      setTyping(true);
      setListenKey((k) => k + 1);
      setPhase('listening');
    }
  };

  const answer = async (index: number, value: string) => {
    const current = planRef.current;
    if (!current) return;
    interrupt();
    setBusy('answer');
    if (live.current) setTurn('thinking');
    try {
      const next = await api.answer(current.run_id, index, value);
      setPlan(next);
      planRef.current = next;
      if (live.current) {
        const t = nextTurn(next, MUTATING);
        void converse(t.say, next.reply_language, t.listen);
      } else {
        setTurn('idle');
      }
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
      setLive(false);
      setTurn('idle');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    const current = planRef.current;
    if (!current) return;
    interrupt();
    const indexes = current.actions.filter((a) => a.status === 'ok' && MUTATING.includes(a.type)).map((a) => a.index);
    setBusy('apply');
    if (live.current) setTurn('thinking');
    try {
      const r = await api.apply(current.run_id, indexes);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setApplied({ indexes: r.applied.map((x) => x.index), until: new Date(r.undo_until).getTime() });
      await qc.invalidateQueries({ queryKey: STATE_KEY });
      setPhase('saved');
      if (live.current) void converse(joinLines(line('done', current.reply_language), line('more', current.reply_language)), current.reply_language, { kind: 'more' });
      else setTurn('idle');
    } catch (err) {
      showBanner(err instanceof ApiError && err.code === 'clash' ? 'Something changed meanwhile and a time is taken now. Nothing was saved.' : errorMessage(err), 'danger');
      setLive(false);
      setTurn('idle');
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (!plan) return;
    interrupt();
    try {
      await api.undo(plan.run_id);
      await qc.invalidateQueries({ queryKey: STATE_KEY });
      showBanner('Undone. Your week is back as it was.');
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
    }
  };

  /** The mic on Review or Saved: voice mode on, listening for what this screen needs. */
  const talk = () => {
    setLive(true);
    const p = planRef.current;
    void converse(null, lang, phase === 'review' && p ? nextTurn(p, MUTATING).listen : { kind: 'request' });
  };

  const voiceBar: VoiceControls = {
    live: liveOn,
    onSkip: () => {
      // end the reply and listen now
      setLive(true);
      stopReply();
    },
    onSendNow: async () => {
      try {
        heard(await voice.stop(), 'tap');
      } catch (err) {
        heard(null, 'tap', err);
      }
    },
    onEnd: () => {
      setLive(false);
      interrupt();
    },
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
            voice={voice}
            typing={typing || sttOff}
            onTyping={(on) => {
              setListenError(null);
              setLive(!on);
              if (on) interrupt();
              setTyping(on);
            }}
            error={listenError ?? (sttOff ? 'Voice isn’t set up on the server yet, so type instead.' : null)}
            onStart={() => {
              setListenError(null);
              setLive(true);
              void listenNow({ kind: 'request' });
            }}
            onStop={voiceBar.onSendNow}
            onText={(text) => {
              setLive(false);
              void ask(text, {});
            }}
            credit={credit}
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
        turn={shownTurn}
        level={voice.level}
        onAnswer={answer}
        onApply={apply}
        onBack={() => {
          interrupt();
          setLive(!typing);
          setListenKey((k) => k + 1);
          setPhase('listening');
        }}
        onTalk={talk}
        voiceBar={voiceBar}
      />
    );
  }
  if (phase === 'saved' && plan && applied) {
    return (
      <Saved
        plan={plan}
        appliedIndexes={applied.indexes}
        undoUntil={applied.until}
        turn={shownTurn}
        level={voice.level}
        onUndo={undo}
        onNext={(text) => {
          setLive(false);
          void ask(text, {});
        }}
        onTalk={talk}
        voiceBar={voiceBar}
      />
    );
  }
  return null;
}
