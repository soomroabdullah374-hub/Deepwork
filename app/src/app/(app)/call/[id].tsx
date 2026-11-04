// Reminder call: the phone rang because a session's reminder went unanswered. A live
// conversation in Roman Urdu or English: DeepWork speaks, you answer, it listens again when
// you pause. Whatever you agree (start now, a little later, another time, skip, or any
// other change, confirmed with a yes) is saved while you talk. It hangs up after its goodbye.

import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, clipBase64 } from '@/lib/api';
import { answerCall, stopRinging } from '@/lib/calls';
import { type Line, line } from '@/lib/conversation';
import { usePulse } from '@/lib/motion';
import { STATE_KEY, useLoadedState } from '@/lib/queries';
import { DarkTheme, fonts, palette, screenPadding } from '@/lib/theme';
import type { CallLine, CallPending, CallTurn } from '@/lib/types';
import { useVoice } from '@/lib/voice';
import { speakReply, stopReply } from '@/lib/voiceReply';
import { DeepWorkMark, Icon, type IconName, T, VoiceBars } from '@/ui';

type Phase = 'connecting' | 'speaking' | 'listening' | 'thinking' | 'ended';
const dk = palette.dark;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

const SAVED: Record<string, string> = {
  start: 'Started',
  snooze: 'A little later',
  move: 'Moved',
  skip: 'Skipped today',
  done: 'Marked done',
  confirm: 'Change saved',
};

function Ring({ delay }: { delay: number }) {
  const p = usePulse(1800 + delay);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 1 + p.value * 0.5 }], opacity: 0.35 * (1 - p.value) }));
  return <Animated.View style={[{ position: 'absolute', width: 120, height: 120, borderRadius: 60, backgroundColor: dk.mark }, style]} />;
}

function RoundButton({ icon, label, color, onPress, disabled, turn }: { icon: IconName; label: string; color: string; onPress: () => void; disabled?: boolean; turn?: boolean }) {
  return (
    <View style={{ alignItems: 'center', gap: 8, opacity: disabled ? 0.4 : 1 }}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => ({ width: 72, height: 72, borderRadius: 36, backgroundColor: color, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}
      >
        <View style={turn ? { transform: [{ rotate: '135deg' }] } : undefined}>
          <Icon name={icon} size={28} color="#FAF9F5" />
        </View>
      </Pressable>
      <T variant="caption" color={dk.textSecondary}>
        {label}
      </T>
    </View>
  );
}

export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLoadedState();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const block = state.blocks.find((b) => b.id === id);
  const lang = state.profile.language === 'ur-Latn' ? 'ur-Latn' : 'en';
  const title = state.profile.hide_titles ? 'Focus session' : block?.title ?? 'Focus session';
  const [phase, setPhase] = useState<Phase>('connecting');
  const [said, setSaid] = useState('');
  const [heard, setHeard] = useState('');
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [saved, setSaved] = useState<string[]>([]);
  // The call so far and a change waiting for a yes; the server gets both every turn.
  const history = useRef<CallLine[]>([]);
  const pending = useRef<CallPending | null>(null);
  const ended = useRef(false);
  const mutedRef = useRef(false);
  const quietTurns = useRef(0);
  const started = useRef(false);

  const voice = useVoice<CallTurn>({
    endOnPause: true,
    pauseMs: 1200,
    send: async (uri) =>
      await api.callTurn({ block_id: id, history: history.current, audio: await clipBase64(uri), mime: 'audio/mp4', pending: pending.current }),
    onAutoStop: (turn, why, error) => void onTurn(turn, why === 'quiet', error),
  });

  const speak = async (l: Line) => {
    setSaid(l.text);
    history.current = [...history.current, { who: 'agent', text: l.text }];
    if (ended.current) return;
    setPhase('speaking');
    await speakReply({ text: l.text, tts: l.tts, language: lang }).catch(() => undefined);
  };

  const listen = async () => {
    if (ended.current) return;
    setPhase('listening');
    if (mutedRef.current) return; // unmuting listens again
    await pause(350); // let the speaker go quiet first
    if (ended.current || mutedRef.current) return;
    try {
      await voice.start();
    } catch {
      await hangUp(line('lineDown', lang));
    }
  };

  const hangUp = async (last?: Line) => {
    if (ended.current) return;
    if (last) await speak(last);
    ended.current = true;
    voice.cancel();
    stopReply();
    setPhase('ended');
    setTimeout(() => {
      if (started.current) router.replace(`/focus/${id}`);
      else if (router.canGoBack()) router.back();
      else router.replace('/today');
    }, 1800);
  };

  async function onTurn(turn: CallTurn | null, nothingSaid: boolean, error?: unknown) {
    if (ended.current) return;
    if (error) return await hangUp(line('lineDown', lang));
    if (!turn || turn.silent || nothingSaid) {
      // "Hello?" once, then leave it for the app
      quietTurns.current += 1;
      if (quietTurns.current >= 2) return await hangUp(line('callLater', lang));
      await speak(line('hello', lang));
      return await listen();
    }
    quietTurns.current = 0;
    if (turn.heard) {
      setHeard(turn.heard);
      history.current = [...history.current, { who: 'user', text: turn.heard }];
    }
    pending.current = turn.pending ?? null;
    if (turn.changed) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      qc.invalidateQueries({ queryKey: STATE_KEY });
      const what = SAVED[turn.action?.type ?? ''] ?? 'Saved';
      if (turn.action?.type === 'start') started.current = true;
      setSaved((s) => [...s, what]);
    }
    if (turn.reply) await speak({ text: turn.reply.text, tts: turn.reply.voice });
    if (turn.end_call) return await hangUp();
    await listen();
  }

  // Answered: stop the ringing, then DeepWork speaks first.
  useEffect(() => {
    if (!id) return;
    stopRinging(id);
    answerCall(id).catch(() => undefined);
    (async () => {
      try {
        await onTurn(await api.callTurn({ block_id: id, history: [] }), false);
      } catch {
        await hangUp(line('lineDown', lang));
      }
    })();
    return () => {
      ended.current = true;
      stopReply();
      voice.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (phase === 'connecting' || phase === 'ended') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const shown: Phase = phase === 'listening' && voice.phase === 'transcribing' ? 'thinking' : phase;
  const status = {
    connecting: 'Connecting…',
    speaking: 'DeepWork is speaking',
    listening: muted ? 'Muted' : 'Listening… pause or tap the circle when done',
    thinking: 'One moment…',
    ended: 'Call ended',
  }[shown];

  // Tapping the circle ends your turn now (also where the phone can't detect a pause).
  const sendNow = async () => {
    if (voice.phase !== 'recording') return;
    try {
      const turn = await voice.stop();
      if (turn) await onTurn(turn, false);
    } catch (err) {
      await onTurn(null, false, err);
    }
  };

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) voice.cancel();
    else if (phase === 'listening') void listen();
  };

  return (
    <DarkTheme>
      <View style={{ flex: 1, backgroundColor: dk.bg, paddingTop: insets.top + 28, paddingBottom: insets.bottom + 28, paddingHorizontal: screenPadding }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <T variant="eyebrow" color={dk.mark}>
            DeepWork · reminder call
          </T>
          <T style={{ fontFamily: fonts.display, fontSize: 28, lineHeight: 34, color: dk.text, textAlign: 'center' }} numberOfLines={2}>
            {title}
          </T>
          <T variant="label" color={dk.textSecondary} accessibilityLiveRegion="polite">
            {`${status}${seconds > 0 ? ` · ${mmss(seconds)}` : ''}`}
          </T>
        </View>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 26 }}>
          <View style={{ width: 180, height: 180, alignItems: 'center', justifyContent: 'center' }}>
            {shown === 'speaking' ? (
              <>
                <Ring delay={0} />
                <Ring delay={700} />
              </>
            ) : null}
            <Pressable
              onPress={() => void sendNow()}
              disabled={shown !== 'listening' || muted}
              accessibilityRole="button"
              accessibilityLabel="Done talking"
              style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: '#1F1E1D', alignItems: 'center', justifyContent: 'center' }}
            >
              <DeepWorkMark size={56} color={dk.mark} animated={shown === 'connecting' || shown === 'thinking'} />
            </Pressable>
          </View>
          <VoiceBars level={voice.level} active={shown === 'listening' && !muted} count={11} height={32} />
          <T style={{ fontFamily: fonts.display, fontSize: 22, lineHeight: 30, color: dk.text, textAlign: 'center' }}>{said}</T>
          {heard ? (
            <T variant="bodySm" color={dk.textSecondary} align="center">
              {`You: “${heard}”`}
            </T>
          ) : null}
        </View>

        {saved.length ? (
          <T variant="caption" color={dk.textSecondary} align="center" style={{ marginBottom: 14 }}>
            {`Saved in your plan: ${saved.join(' · ')}`}
          </T>
        ) : null}
        <View style={{ flexDirection: 'row', justifyContent: 'space-evenly' }}>
          <RoundButton icon={muted ? 'micOff' : 'mic'} label={muted ? 'Unmute' : 'Mute'} color="#30302E" onPress={toggleMute} disabled={shown === 'ended'} />
          <RoundButton icon="phone" turn label="End call" color="#C4453C" onPress={() => void hangUp()} disabled={shown === 'ended'} />
        </View>
      </View>
    </DarkTheme>
  );
}
