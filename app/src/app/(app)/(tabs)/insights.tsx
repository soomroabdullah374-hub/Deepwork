// [14] Insights: the week's show-up rate, hours per day and progress by goal.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { hoursLabel, streakLine, type WeekStats, weekStats } from '@/lib/model';
import { useDraw } from '@/lib/motion';
import { useLoadedState, useNow } from '@/lib/queries';
import { fonts, screenPadding, useTheme } from '@/lib/theme';
import { addDays, localDate, localToUtc, mondayOf, MONTHS_SHORT } from '@/lib/time';
import { Card, IconButton, onInk, ProgressBar, ProgressRing, T, TAB_BAR_SPACE } from '@/ui';

function rangeLabel(start: string, end: string): string {
  const [, sm, sd] = start.split('-').map(Number);
  const [, em, ed] = end.split('-').map(Number);
  return sm === em ? `${sd}–${ed} ${MONTHS_SHORT[em - 1]}` : `${sd} ${MONTHS_SHORT[sm - 1]} – ${ed} ${MONTHS_SHORT[em - 1]}`;
}

function Bar({ planned, done, missed, max, today }: { planned: number; done: number; missed: number; max: number; today: boolean }) {
  const { c } = useTheme();
  const p = useDraw(500);
  const H = 96;
  const h = (m: number) => (max > 0 ? (m / max) * H : 0);
  const grow = useAnimatedStyle(() => ({ height: h(done) * p.value }));
  return (
    <View style={{ height: H, width: 22, justifyContent: 'flex-end' }}>
      {planned > 0 ? <View style={{ position: 'absolute', bottom: 0, width: 22, height: h(planned), borderRadius: 4, backgroundColor: c.sand }} /> : null}
      {missed > 0 ? (
        <View
          style={{
            position: 'absolute',
            bottom: h(done),
            width: 22,
            height: Math.max(h(missed), 4),
            borderRadius: 4,
            borderWidth: 1.5,
            borderStyle: 'dashed',
            borderColor: c.danger,
          }}
        />
      ) : null}
      <Animated.View style={[{ width: 22, borderRadius: 4, backgroundColor: c.mark }, grow]} />
      {today ? <View style={{ position: 'absolute', bottom: -6, alignSelf: 'center', width: 4, height: 4, borderRadius: 2, backgroundColor: c.text }} /> : null}
    </View>
  );
}

function HoursChart({ w }: { w: WeekStats }) {
  const { c } = useTheme();
  const max = Math.max(60, ...w.days.map((d) => Math.max(d.plannedMin, d.doneMin + d.missedMin)));
  const topHours = Math.max(1, Math.ceil(max / 60));
  return (
    <Card style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <T variant="h2">Hours</T>
        <T variant="caption" tone="secondary">
          <T variant="caption" style={{ fontFamily: fonts.uiBold }}>
            {hoursLabel(w.doneHours)}
          </T>
          {` done of ${hoursLabel(w.plannedHours)} planned`}
        </T>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ height: 96, justifyContent: 'space-between' }}>
          {[`${topHours}h`, topHours > 1 ? `${Math.round(topHours / 2)}h` : '', '0'].map((l, i) => (
            <T key={i} variant="caption" tone="secondary" style={{ fontFamily: fonts.mono, fontSize: 10 }}>
              {l}
            </T>
          ))}
        </View>
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-around', borderBottomWidth: 1, borderColor: c.line }}>
          {w.days.map((d) => (
            <Bar key={d.date} planned={d.plannedMin} done={d.doneMin} missed={d.missedMin} max={topHours * 60} today={d.isToday} />
          ))}
        </View>
      </View>
      <View style={{ flexDirection: 'row', marginLeft: 26 }}>
        {w.days.map((d) => (
          <T key={d.date} variant="caption" tone="secondary" align="center" style={{ flex: 1, fontFamily: fonts.mono, fontSize: 11 }}>
            {d.letter}
          </T>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        {[
          { label: 'Done', style: { backgroundColor: c.mark } },
          { label: 'Planned', style: { backgroundColor: c.sand, borderWidth: 1, borderColor: c.lineStrong } },
          { label: 'Missed', style: { borderWidth: 1.5, borderStyle: 'dashed' as const, borderColor: c.danger } },
        ].map((l) => (
          <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={[{ width: 10, height: 10, borderRadius: 2 }, l.style]} />
            <T variant="caption" tone="secondary">
              {l.label}
            </T>
          </View>
        ))}
      </View>
    </Card>
  );
}

export default function Insights() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const state = useLoadedState();
  const now = useNow(60_000);
  const tz = state.profile.timezone;
  const thisMonday = mondayOf(localDate(now, tz));
  const [monday, setMonday] = useState(thisMonday);
  const end = addDays(monday, 6);
  // the current week is already in the app state; other weeks are fetched
  const inState = monday >= addDays(thisMonday, -7);
  const other = useQuery({
    queryKey: ['blocks', monday],
    enabled: !inState,
    queryFn: () => api.blocks(localToUtc(monday, tz), localToUtc(addDays(monday, 7), tz)),
  });
  const blocks = inState ? state.blocks : (other.data ?? []);
  const w = weekStats(state, blocks, monday, now);
  const isThisWeek = monday === thisMonday;
  const streak = isThisWeek ? streakLine(state.streak, tz, now) : null;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: screenPadding, paddingBottom: TAB_BAR_SPACE + insets.bottom + 16, gap: 16 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T variant="h1">Insights</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.sand, borderRadius: 999, paddingHorizontal: 4 }}>
            <IconButton icon="chevronLeft" label="Previous week" tone="clear" size={36} iconSize={16} onPress={() => setMonday(addDays(monday, -7))} />
            <T variant="caption" style={{ fontFamily: fonts.uiBold, minWidth: 74, textAlign: 'center' }}>
              {rangeLabel(monday, end)}
            </T>
            <IconButton
              icon="chevronRight"
              label="Next week"
              tone="clear"
              size={36}
              iconSize={16}
              onPress={() => !isThisWeek && setMonday(addDays(monday, 7))}
              style={{ opacity: isThisWeek ? 0.3 : 1 }}
            />
          </View>
        </View>

        <Card tone="ink" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 20 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <T variant="eyebrow" color={onInk.accent}>
              {isThisWeek ? 'This week' : rangeLabel(monday, end)}
            </T>
            <T variant="display" color={onInk.text}>
              {w.due ? `${w.shownUp} of ${w.due}` : '—'}
            </T>
            <T variant="bodySm" color={onInk.secondary}>
              {w.due ? `sessions you showed up for.${streak ? ` ${streak}` : ''}` : 'No sessions were due yet this week.'}
            </T>
          </View>
          <ProgressRing size={92} stroke={12} progress={w.rate} track="#30302E" color="#D97757">
            <T variant="label" color={onInk.text} style={{ fontSize: 18 }}>{`${Math.round(w.rate * 100)}%`}</T>
          </ProgressRing>
        </Card>

        <HoursChart w={w} />

        <Card style={{ gap: 14 }}>
          <T variant="h2">By goal</T>
          {w.byGoal.length === 0 ? (
            <T tone="secondary">No sessions this week.</T>
          ) : (
            w.byGoal.map((g) => (
              <View key={g.goalId} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                  <T variant="bodySm" style={{ flex: 1 }} numberOfLines={1}>
                    {state.profile.hide_titles ? 'Focus goal' : g.title}
                  </T>
                  <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono }}>
                    {`${hoursLabel(g.doneHours)} / ${hoursLabel(g.plannedHours)}h${g.today ? ' · today' : ''}`}
                  </T>
                </View>
                <ProgressBar progress={g.plannedHours ? g.doneHours / g.plannedHours : 0} />
              </View>
            ))
          )}
        </Card>
      </ScrollView>
    </View>
  );
}
