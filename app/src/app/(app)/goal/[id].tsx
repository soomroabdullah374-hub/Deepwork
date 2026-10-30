// [05] Goal detail: progress, next session, the plan as a stepper, recent sessions.

import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { cadenceShort, daysLeft, goalNextSession, goalProgress, milestonesDone, nudgeTime } from '@/lib/model';
import { useChange, useLoadedState, useNow } from '@/lib/queries';
import { fonts, useTheme } from '@/lib/theme';
import { dayLabel, localDate, localTime, MONTHS_SHORT, WEEKDAYS_SHORT, weekdayOf } from '@/lib/time';
import type { Block, Milestone } from '@/lib/types';
import { Button, Card, Icon, IconButton, onInk, ProgressRing, Screen, SectionTitle, T } from '@/ui';

function Step({ m, state, last, onToggle }: { m: Milestone; state: 'done' | 'current' | 'next'; last: boolean; onToggle: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: state === 'done' }}
      accessibilityLabel={`${m.title}${state === 'current' ? ', in progress' : ''}`}
      style={{ flexDirection: 'row', gap: 14, minHeight: 44 }}
    >
      <View style={{ alignItems: 'center', width: 24 }}>
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: state === 'done' ? c.success : 'transparent',
            borderWidth: state === 'done' ? 0 : 2,
            borderColor: state === 'current' ? c.mark : c.lineStrong,
          }}
        >
          {state === 'done' ? <Icon name="check" size={14} color="#FAF9F5" strokeWidth={2.6} /> : null}
          {state === 'current' ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.mark }} /> : null}
        </View>
        {!last ? <View style={{ flex: 1, width: 2, backgroundColor: state === 'done' ? c.success : c.line, marginVertical: 2 }} /> : null}
      </View>
      <View style={{ flex: 1, paddingBottom: 14 }}>
        <T variant="body" tone={state === 'done' ? 'secondary' : 'text'} style={{ fontFamily: state === 'current' ? fonts.uiBold : fonts.ui }}>
          {m.title}
        </T>
        {state === 'current' ? (
          <T variant="caption" tone="mark">
            In progress
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}

function StatusPill({ b }: { b: Block }) {
  const { c } = useTheme();
  const map: Record<string, { label: string; bg: string; fg: string; border?: string }> = {
    done: { label: 'Done', bg: c.success, fg: '#FAF9F5' },
    missed: { label: 'Missed', bg: 'transparent', fg: c.danger, border: c.danger },
    skipped: { label: 'Skipped', bg: c.sand, fg: c.textSecondary },
    in_progress: { label: 'Running', bg: c.mark, fg: '#FAF9F5' },
  };
  const s = map[b.status] ?? { label: b.status, bg: c.sand, fg: c.text };
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, backgroundColor: s.bg, borderWidth: s.border ? 1 : 0, borderColor: s.border }}>
      <T variant="caption" color={s.fg} style={{ fontFamily: fonts.uiBold }}>
        {s.label}
      </T>
    </View>
  );
}

export default function GoalDetail() {
  const { c } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLoadedState();
  const now = useNow(60_000);
  const goal = state.goals.find((g) => g.id === id);
  const recent = useQuery({ queryKey: ['recent', id], queryFn: () => api.recentSessions(id, 6), enabled: Boolean(goal) });
  const toggle = useChange(({ mid, done }: { mid: string; done: boolean }) => api.setMilestoneDone(mid, done));

  if (!goal) {
    return (
      <Screen>
        <T variant="h2">This goal is gone.</T>
        <Button label="Back to goals" variant="secondary" onPress={() => router.navigate('/goals')} />
      </Screen>
    );
  }
  const tz = state.profile.timezone;
  const pct = goalProgress(goal);
  const next = goalNextSession(state, goal, now);
  const [y, mo, d] = goal.deadline.split('-').map(Number);
  const currentIdx = goal.milestones.findIndex((m) => !m.done_at);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.navigate('/goals'))} />
        <Button label="Edit goal" variant="secondary" compact onPress={() => router.push(`/goal/edit/${goal.id}`)} style={{ borderRadius: 999 }} />
      </View>
      <View style={{ gap: 6 }}>
        <T variant="eyebrow" tone="secondary">{`Goal · due ${d} ${MONTHS_SHORT[mo - 1]} ${y}${goal.status !== 'active' ? ` · ${goal.status}` : ''}`}</T>
        <T variant="h1">{goal.title}</T>
        {goal.why ? <T tone="secondary">{goal.why}</T> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 24 }}>
        <ProgressRing size={116} stroke={14} progress={pct} accessibilityLabel={`${Math.round(pct * 100)} percent done`}>
          <T style={{ fontFamily: fonts.display, fontSize: 28, lineHeight: 32, color: c.text }}>{`${Math.round(pct * 100)}%`}</T>
          <T variant="caption" tone="secondary">
            done
          </T>
        </ProgressRing>
        <View style={{ gap: 12 }}>
          <View>
            <T style={{ fontFamily: fonts.display, fontSize: 22, lineHeight: 26, color: c.text }}>{`${daysLeft(goal, now, tz)} days`}</T>
            <T variant="caption" tone="secondary">
              until the deadline
            </T>
          </View>
          <View>
            <T style={{ fontFamily: fonts.display, fontSize: 22, lineHeight: 26, color: c.text }}>{`${milestonesDone(goal)} of ${goal.milestones.length}`}</T>
            <T variant="caption" tone="secondary">
              milestones done
            </T>
          </View>
        </View>
      </View>

      <Card tone="ink" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="eyebrow" color={onInk.accent}>
            Next session
          </T>
          {next ? (
            <T variant="label" color={onInk.text} style={{ fontFamily: fonts.monoMedium, fontSize: 15 }}>
              {`${dayLabel(localDate(next.starts_at, tz))} · ${localTime(next.starts_at, tz)}–${localTime(next.ends_at, tz)}`}
            </T>
          ) : (
            <T variant="label" color={onInk.text}>
              {goal.status === 'active' ? 'None in the next two weeks' : `Goal is ${goal.status}`}
            </T>
          )}
          {goal.rule ? (
            <T variant="caption" color={onInk.secondary}>
              {`${cadenceShort(goal.rule.weekdays)} · reminder at ${nudgeTime(goal.rule)}`}
            </T>
          ) : null}
        </View>
        {next ? <IconButton icon="play" label="Start this session" tone="kiln" size={48} onPress={() => router.push(`/focus/${next.id}`)} /> : null}
      </Card>

      <SectionTitle>Plan</SectionTitle>
      {goal.milestones.length === 0 ? (
        <T tone="secondary">No milestones yet. Add some from Edit goal.</T>
      ) : (
        <View>
          {goal.milestones.map((m, i) => (
            <Step
              key={m.id}
              m={m}
              last={i === goal.milestones.length - 1}
              state={m.done_at ? 'done' : i === currentIdx ? 'current' : 'next'}
              onToggle={() =>
                toggle.mutate(
                  { mid: m.id, done: !m.done_at },
                  { onError: (e) => showBanner(errorMessage(e), 'danger') },
                )
              }
            />
          ))}
        </View>
      )}

      <SectionTitle>Recent sessions</SectionTitle>
      <Card padded={false}>
        {(recent.data ?? []).length === 0 ? (
          <T tone="secondary" style={{ padding: 16 }}>
            {recent.isLoading ? 'Loading…' : 'Finished and missed sessions show up here.'}
          </T>
        ) : (
          (recent.data ?? []).map((b, i) => {
            const day = localDate(b.starts_at, tz);
            const planned = Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000);
            return (
              <View
                key={b.id}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, minHeight: 52, borderTopWidth: i ? 1 : 0, borderColor: c.line, gap: 12 }}
              >
                <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono, width: 52 }}>
                  {`${WEEKDAYS_SHORT[weekdayOf(day)]} ${Number(day.slice(8))}`}
                </T>
                <T variant="bodySm" style={{ flex: 1 }}>
                  {b.status === 'done' ? `${b.minutes_done ?? planned} of ${planned} min` : b.status === 'missed' ? 'Not started' : b.note ?? b.status}
                </T>
                <StatusPill b={b} />
              </View>
            );
          })
        )}
      </Card>
    </Screen>
  );
}
