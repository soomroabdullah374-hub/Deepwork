// [01] Today (light) · [02] Today (dark) · [03] Today first run.

import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import {
  currentMilestone,
  goalById,
  goalProgress,
  greeting,
  missedSessions,
  nextSession,
  todaySummary,
} from '@/lib/model';
import { usePulse, useRise } from '@/lib/motion';
import { useAppState, useChange, useLoadedState, useNow } from '@/lib/queries';
import { fonts, screenPadding, useTheme } from '@/lib/theme';
import { dayLabel, localDate, localTime, longDay, relativeIn, WEEKDAYS_LONG, weekdayOf } from '@/lib/time';
import type { AppState, Block } from '@/lib/types';
import { Avatar, BrandRow, Button, Card, DayRibbon, Icon, onInk, RingFlag, T, TAB_BAR_SPACE } from '@/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function Rise({ i, children }: { i: number; children: React.ReactNode }) {
  return <Animated.View style={useRise(i)}>{children}</Animated.View>;
}

function PulseDot({ color }: { color: string }) {
  const p = usePulse(900);
  const style = useAnimatedStyle(() => ({ opacity: 1 - p.value * 0.6 }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, style]} />;
}

function UpNext({ state, block, now }: { state: AppState; block: Block; now: Date }) {
  const tz = state.profile.timezone;
  const goal = goalById(state, block.goal_id);
  const milestone = goal ? currentMilestone(goal) : null;
  const running = new Date(block.starts_at) <= now;
  const snooze = useChange(() => api.blockAction(block.id, 'snooze', { minutes: 10 }));
  const progress = goal ? goalProgress(goal) : 0;
  const size = 190;
  const r = 70;
  const circ = 2 * Math.PI * r;
  const label = block.status === 'in_progress' ? 'In progress' : running ? 'Up next · now' : `Up next · ${relativeIn(now, new Date(block.starts_at))}`;
  return (
    <Card tone="ink" padded={false} style={{ padding: 20, gap: 10 }}>
      <View style={{ position: 'absolute', right: -60, top: -64, width: size, height: size }} accessibilityElementsHidden>
        <Svg width={size} height={size}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke="#30302E" strokeWidth={30} fill="none" />
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="#D97757"
            strokeWidth={30}
            fill="none"
            strokeDasharray={`${circ * Math.max(0.12, progress)} ${circ}`}
            strokeLinecap="round"
            transform={`rotate(90 ${size / 2} ${size / 2})`}
          />
        </Svg>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <PulseDot color={onInk.accent} />
        <T variant="eyebrow" color={onInk.accent}>
          {label}
        </T>
      </View>
      <T variant="h2" color={onInk.text} style={{ fontSize: 26, lineHeight: 32, marginRight: 70 }} numberOfLines={3}>
        {state.profile.hide_titles ? 'Focus session' : (milestone?.title ?? block.title)}
      </T>
      <T variant="bodySm" color={onInk.secondary}>
        {state.profile.hide_titles ? '' : `${block.title} · `}
        <T variant="bodySm" color={onInk.secondary} style={{ fontFamily: fonts.mono }}>
          {`${localTime(block.starts_at, tz)}–${localTime(block.ends_at, tz)}`}
        </T>
      </T>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
        <Button label={block.status === 'in_progress' ? 'Continue' : 'Start now'} icon="play" style={{ flex: 1 }} onPress={() => router.push(`/focus/${block.id}`)} />
        {block.status !== 'in_progress' ? (
          <Button
            label="Snooze"
            variant="dark"
            loading={snooze.isPending}
            onPress={() =>
              snooze.mutate(undefined, {
                onSuccess: () => showBanner('Snoozed for 10 minutes.'),
                onError: (e) => showBanner(errorMessage(e), 'danger'),
              })
            }
          />
        ) : null}
      </View>
    </Card>
  );
}

function MissedCard({ state, block }: { state: AppState; block: Block }) {
  const { c } = useTheme();
  const tz = state.profile.timezone;
  const day = localDate(block.starts_at, tz);
  const today = localDate(new Date(), tz);
  const when = day === today ? "Today's" : `${WEEKDAYS_LONG[weekdayOf(day)]}'s`;
  return (
    <Card onPress={() => router.push(`/move/${block.id}`)} accessibilityLabel={`${when} session was missed. Pick a free slot.`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.sand, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="retry" size={20} color={c.mark} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="label" style={{ fontSize: 16 }}>{`${when} session was missed`}</T>
          <T variant="caption" tone="secondary">{`${state.profile.hide_titles ? 'Focus session' : block.title} · pick a free slot`}</T>
        </View>
        <Icon name="chevronRight" size={20} color={c.textSecondary} />
      </View>
    </Card>
  );
}

function FirstRun() {
  const { c } = useTheme();
  const steps = ['Name it and set a deadline', 'Pick your days and time', 'Get a nudge before each session'];
  return (
    <View style={{ gap: 18, marginTop: 8 }}>
      <View style={{ alignItems: 'center' }}>
        <RingFlag size={170} />
      </View>
      <T variant="h1">Your first goal starts here.</T>
      <T tone="secondary">Give it a deadline and a weekly rhythm. DeepWork turns it into sessions and nudges you when it's time.</T>
      <View style={{ gap: 12 }}>
        {steps.map((s, i) => (
          <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: i === 0 ? c.inverseSurface : c.sand, alignItems: 'center', justifyContent: 'center' }}>
              <T variant="caption" style={{ fontFamily: fonts.uiBold }} color={i === 0 ? (c.inverseSurface === '#141413' ? '#FAF9F5' : '#141413') : c.text}>
                {i + 1}
              </T>
            </View>
            <T>{s}</T>
          </View>
        ))}
      </View>
      <Button label="Create a goal" onPress={() => router.push('/new-goal')} />
      <Button label="Or just say it out loud" icon="mic" variant="link" onPress={() => router.push('/assistant')} />
    </View>
  );
}

function Conflicts({ state }: { state: AppState }) {
  const { c } = useTheme();
  const tz = state.profile.timezone;
  const first = state.conflicts.find((x) => x.kind === 'session');
  if (!first) return null;
  const n = state.conflicts.filter((x) => x.kind === 'session').length;
  return (
    <Card tone="danger" onPress={() => router.push(`/goal/${first.ref_id}`)} accessibilityLabel="Sessions that could not be placed">
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <Icon name="alert" size={20} color={c.danger} />
        <T variant="bodySm" style={{ flex: 1 }}>
          {`${n} session${n === 1 ? '' : 's'} couldn't be placed: ${dayLabel(localDate(first.starts_at, tz)).slice(0, 3)} ${localTime(first.starts_at, tz)} clashes with ${first.clash_title ?? 'something'}. `}
          <T variant="bodySm" tone="button">
            Pick another time?
          </T>
        </T>
      </View>
    </Card>
  );
}

export default function Today() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const state = useLoadedState();
  const query = useAppState();
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);
  const tz = state.profile.timezone;
  const today = localDate(now, tz);
  const next = nextSession(state, now);
  const missed = missedSessions(state, now)[0];
  const firstRun = state.goals.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingHorizontal: screenPadding, paddingBottom: TAB_BAR_SPACE + insets.bottom + 16, gap: 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.mark}
            colors={[c.mark]}
            onRefresh={async () => {
              setRefreshing(true);
              await query.refetch();
              setRefreshing(false);
            }}
          />
        }
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <BrandRow />
          <Avatar name={state.profile.display_name || 'You'} onPress={() => router.navigate('/settings')} />
        </View>
        {firstRun ? (
          <FirstRun />
        ) : (
          <>
            <Rise i={0}>
              <View style={{ gap: 6, marginTop: 4 }}>
                <T variant="eyebrow" tone="secondary">
                  {longDay(today)}
                </T>
                <T variant="display">{greeting(now, tz, state.profile.display_name)}</T>
                <T tone="secondary">{todaySummary(state, now)}</T>
              </View>
            </Rise>
            <Rise i={1}>
              <Card>
                <DayRibbon
                  blocks={state.blocks}
                  now={now}
                  tz={tz}
                  onPressBlock={(b) => (b.kind === 'session' ? router.push(b.goal_id ? `/goal/${b.goal_id}` : '/today') : router.push('/schedule'))}
                />
              </Card>
            </Rise>
            <Conflicts state={state} />
            {next ? (
              <Rise i={2}>
                <UpNext state={state} block={next} now={now} />
              </Rise>
            ) : (
              <Rise i={2}>
                <Card>
                  <T variant="cardTitle">Nothing else planned today.</T>
                  <T tone="secondary" style={{ marginTop: 4 }}>
                    Enjoy the gap, or add a session with the mic.
                  </T>
                </Card>
              </Rise>
            )}
            {missed ? (
              <Rise i={3}>
                <MissedCard state={state} block={missed} />
              </Rise>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
