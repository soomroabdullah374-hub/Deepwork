// [04] Goals: Active · n | Paused | Done, each with a progress ring and next session.

import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cadenceLetters, daysLeft, goalNextSession, goalProgress, milestonesDone } from '@/lib/model';
import { useRise } from '@/lib/motion';
import { useLoadedState, useNow } from '@/lib/queries';
import { fonts, screenPadding, useTheme } from '@/lib/theme';
import { localDate, localTime, shortDate, WEEKDAYS_SHORT, weekdayOf } from '@/lib/time';
import type { AppState, Goal, GoalStatus } from '@/lib/types';
import { Card, Chip, IconButton, ProgressRing, Segmented, T, TAB_BAR_SPACE } from '@/ui';

function GoalCard({ state, goal, index, now }: { state: AppState; goal: Goal; index: number; now: Date }) {
  const { c } = useTheme();
  const rise = useRise(index);
  const tz = state.profile.timezone;
  const pct = goalProgress(goal);
  const next = goalNextSession(state, goal, now);
  const days = daysLeft(goal, now, tz);
  const nextDay = next ? localDate(next.starts_at, tz) : null;
  const isToday = nextDay === localDate(now, tz);
  return (
    <Animated.View style={rise}>
      <Card onPress={() => router.push(`/goal/${goal.id}`)} accessibilityLabel={`${goal.title}, ${Math.round(pct * 100)} percent`}>
        <View style={{ flexDirection: 'row', gap: 14 }}>
          <ProgressRing size={56} stroke={6} progress={pct}>
            <T variant="caption" style={{ fontFamily: fonts.uiBold, fontSize: 13 }}>{`${Math.round(pct * 100)}%`}</T>
          </ProgressRing>
          <View style={{ flex: 1, gap: 4 }}>
            <T variant="cardTitle">{goal.title}</T>
            <T variant="caption" tone="secondary">
              {`Due ${shortDate(goal.deadline)} · ${days} day${days === 1 ? '' : 's'} · ${milestonesDone(goal)} of ${goal.milestones.length} milestones`}
            </T>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
              {next ? (
                <Chip
                  icon="clock"
                  tone={isToday ? 'ink' : 'sand'}
                  label={`${isToday ? 'Today' : WEEKDAYS_SHORT[weekdayOf(nextDay as string)]} ${localTime(next.starts_at, tz)}`}
                />
              ) : (
                <T variant="caption" tone="secondary">
                  {goal.status === 'active' ? 'No session in the next two weeks' : goal.status === 'paused' ? 'Paused' : 'Finished'}
                </T>
              )}
              {goal.rule ? (
                <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono }}>
                  {cadenceLetters(goal.rule.weekdays)}
                </T>
              ) : null}
            </View>
          </View>
        </View>
      </Card>
    </Animated.View>
  );
}

export default function Goals() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const state = useLoadedState();
  const now = useNow(60_000);
  const [tab, setTab] = useState<GoalStatus>('active');
  const counts = { active: 0, paused: 0, done: 0 };
  state.goals.forEach((g) => counts[g.status]++);
  const goals = state.goals.filter((g) => g.status === tab);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: screenPadding, paddingBottom: TAB_BAR_SPACE + insets.bottom + 16, gap: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ gap: 4 }}>
            <T variant="h1">Goals</T>
            <T tone="secondary">What you're working toward.</T>
          </View>
          <IconButton icon="plus" label="New goal" tone="ink" size={52} iconSize={24} onPress={() => router.push('/new-goal')} />
        </View>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'active', label: `Active · ${counts.active}` },
            { value: 'paused', label: counts.paused ? `Paused · ${counts.paused}` : 'Paused' },
            { value: 'done', label: counts.done ? `Done · ${counts.done}` : 'Done' },
          ]}
        />
        {goals.length === 0 ? (
          <Card>
            <T variant="cardTitle">{tab === 'active' ? 'No active goals yet.' : tab === 'paused' ? 'Nothing paused.' : 'Nothing finished yet.'}</T>
            <T tone="secondary" style={{ marginTop: 4 }}>
              {tab === 'active' ? 'Create one and DeepWork will book the sessions.' : 'Goals you pause or finish show up here.'}
            </T>
          </Card>
        ) : (
          goals.map((g, i) => <GoalCard key={g.id} state={state} goal={g} index={i} now={now} />)
        )}
      </ScrollView>
    </View>
  );
}
