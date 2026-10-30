// [10] Focus session (always dark): countdown ring, pause, snooze, finish or skip.
// Keeps the screen awake. Reminders for a running session are not scheduled.

import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { currentMilestone, goalById, sessionNumber } from '@/lib/model';
import { usePulse } from '@/lib/motion';
import { queryClient, STATE_KEY, useLoadedState } from '@/lib/queries';
import { DarkTheme, fonts, palette } from '@/lib/theme';
import { minutesBetween } from '@/lib/time';
import type { Block } from '@/lib/types';
import { Button, Chip, Field, Icon, IconButton, Sheet, T } from '@/ui';

const d = palette.dark;

function fmt(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function Ring({ progress, children }: { progress: number; children: React.ReactNode }) {
  const breathe = usePulse(5000);
  const halo = useAnimatedStyle(() => ({ transform: [{ scale: 1 + breathe.value * 0.04 }], opacity: 0.35 + breathe.value * 0.25 }));
  const size = 300;
  const r = 134;
  const circ = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 14, borderColor: '#3A2A22' }, halo]} />
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="#2A2927" strokeWidth={10} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={d.mark}
          strokeWidth={10}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circ * Math.max(0.002, Math.min(1, progress))} ${circ}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

function FocusInner({ block }: { block: Block }) {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const state = useLoadedState();
  const tz = state.profile.timezone;
  const goal = goalById(state, block.goal_id);
  const milestone = goal ? currentMilestone(goal) : null;
  const number = goal ? sessionNumber(goal, tz) : null;
  const totalMs = minutesBetween(block.starts_at, block.ends_at) * 60_000;

  const [startedAt, setStartedAt] = useState<number>(() => (block.started_at ? new Date(block.started_at).getTime() : Date.now()));
  const [paused, setPaused] = useState(false);
  const pausedTotal = useRef(0);
  const pausedSince = useRef<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sheet, setSheet] = useState<null | 'finish' | 'skip'>(null);
  const [minutes, setMinutes] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ended = useRef(false);

  // Mark it started on the server (once).
  useEffect(() => {
    if (block.status === 'in_progress') return;
    api
      .blockAction(block.id, 'start')
      .then((b) => {
        if (b.started_at) setStartedAt(new Date(b.started_at).getTime());
        queryClient.invalidateQueries({ queryKey: STATE_KEY });
      })
      .catch((err) => showBanner(errorMessage(err), 'danger'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const pausedNow = paused && pausedSince.current ? now - pausedSince.current : 0;
  const elapsed = Math.max(0, now - startedAt - pausedTotal.current - pausedNow);
  const remaining = totalMs - elapsed;

  useEffect(() => {
    if (remaining <= 0 && !ended.current) {
      ended.current = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setMinutes(Math.round(totalMs / 60_000));
      setSheet('finish');
    }
  }, [remaining, totalMs]);

  const togglePause = () => {
    if (paused) {
      pausedTotal.current += Date.now() - (pausedSince.current ?? Date.now());
      pausedSince.current = null;
      setPaused(false);
    } else {
      pausedSince.current = Date.now();
      setPaused(true);
    }
  };

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: STATE_KEY });
      showBanner(message);
      router.back();
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
      setBusy(false);
    }
  };

  const focusedMinutes = Math.max(1, Math.round(elapsed / 60_000));
  const totalMinutes = Math.round(totalMs / 60_000);

  return (
    <View style={{ flex: 1, backgroundColor: d.bg, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 20, paddingHorizontal: 20 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <IconButton icon="chevronDown" label="Close" tone="dark" onPress={() => router.back()} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: d.lineStrong, borderRadius: 999, paddingHorizontal: 12, minHeight: 32 }}>
          <Icon name="moon" size={14} color={d.textSecondary} />
          <T variant="caption" color={d.textSecondary}>
            Reminders paused
          </T>
        </View>
      </View>

      <View style={{ alignItems: 'center', marginTop: 28, gap: 6 }}>
        <T variant="eyebrow" color={d.mark}>
          {number ? `Deep work · session ${number.n} of ${number.of}` : 'Deep work'}
        </T>
        <T variant="h2" color={d.text} align="center" style={{ fontSize: 26, lineHeight: 32 }}>
          {state.profile.hide_titles ? 'Focus session' : block.title}
        </T>
      </View>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Ring progress={elapsed / totalMs}>
          <T style={{ fontFamily: fonts.mono, fontSize: 64, lineHeight: 72, letterSpacing: -2, color: d.text }} accessibilityLabel={`${fmt(remaining)} left`}>
            {fmt(remaining)}
          </T>
          <T variant="bodySm" color={d.textSecondary}>{paused ? 'Paused' : `left of ${totalMinutes} minutes`}</T>
          {milestone ? (
            <View style={{ marginTop: 12, maxWidth: 220 }}>
              <Chip label={`Milestone ${goal!.milestones.indexOf(milestone) + 1} · ${milestone.title}`} tone="sand" style={{ backgroundColor: '#2A2927', borderColor: '#2A2927' }} />
            </View>
          ) : null}
        </Ring>
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <IconButton
            icon="alarm"
            label="Snooze 10 minutes"
            tone="dark"
            size={56}
            onPress={() => act(() => api.blockAction(block.id, 'snooze', { minutes: 10 }), 'Snoozed for 10 minutes.')}
          />
          <T variant="caption" color={d.textSecondary}>
            Snooze 10m
          </T>
        </View>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <IconButton icon={paused ? 'play' : 'pause'} label={paused ? 'Resume' : 'Pause'} tone="ivory" size={80} iconSize={28} onPress={togglePause} />
          <T variant="label" color={d.text}>
            {paused ? 'Resume' : 'Pause'}
          </T>
        </View>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <IconButton
            icon="check"
            label="Finish"
            tone="kiln"
            size={56}
            onPress={() => {
              setMinutes(Math.min(focusedMinutes, totalMinutes * 2));
              setSheet('finish');
            }}
          />
          <T variant="caption" color={d.textSecondary}>
            Finish
          </T>
        </View>
      </View>
      <Button label="Skip this session" variant="link" style={{ alignSelf: 'center', marginTop: 16 }} onPress={() => setSheet('skip')} />

      <Sheet visible={sheet === 'finish'} onClose={() => setSheet(null)}>
        <T variant="h2">Nice work.</T>
        <T tone="secondary">How many minutes did you focus?</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <IconButton icon="arrowDown" label="Five minutes less" onPress={() => setMinutes(Math.max(1, minutes - 5))} />
          <T style={{ fontFamily: fonts.mono, fontSize: 40, lineHeight: 48, minWidth: 110, textAlign: 'center' }} tone="text">
            {minutes}
          </T>
          <IconButton icon="arrowUp" label="Five minutes more" onPress={() => setMinutes(Math.min(600, minutes + 5))} />
        </View>
        <Button
          label={`Done · ${minutes} min`}
          loading={busy}
          onPress={() => act(() => api.blockAction(block.id, 'finish', { minutes }), `Saved: ${minutes} minutes of deep work.`)}
        />
        <Button label="Skip it instead" variant="secondary" onPress={() => setSheet('skip')} />
      </Sheet>

      <Sheet visible={sheet === 'skip'} onClose={() => setSheet(null)}>
        <T variant="h2">Skip this session?</T>
        <T tone="secondary">No guilt. A reason helps you spot patterns later.</T>
        <Field label="Reason · optional" value={reason} onChangeText={setReason} placeholder="Too tired, travelling, something came up…" />
        <Button
          label="Skip session"
          loading={busy}
          onPress={() => act(() => api.blockAction(block.id, 'skip', { reason: reason.trim() }), 'Session skipped.')}
        />
      </Sheet>
    </View>
  );
}

export default function Focus() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLoadedState();
  const block = state.blocks.find((b) => b.id === id);
  if (!block) {
    return (
      <DarkTheme>
        <View style={{ flex: 1, backgroundColor: d.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 }}>
          <T color={d.text} align="center">
            This session isn't on your schedule anymore.
          </T>
          <Button label="Back" variant="secondary" onPress={() => router.back()} />
        </View>
      </DarkTheme>
    );
  }
  if (block.status === 'done' || block.status === 'skipped' || block.status === 'cancelled') {
    return (
      <DarkTheme>
        <View style={{ flex: 1, backgroundColor: d.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 }}>
          <T color={d.text} align="center">{`This session is already ${block.status === 'done' ? 'done' : block.status}.`}</T>
          <Button label="Back" variant="secondary" onPress={() => router.back()} />
        </View>
      </DarkTheme>
    );
  }
  return (
    <DarkTheme>
      <FocusInner block={block} />
    </DarkTheme>
  );
}
