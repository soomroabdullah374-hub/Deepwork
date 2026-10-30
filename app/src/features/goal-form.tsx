// Pieces shared by New goal and Edit goal: deadline calendar, milestone editor and the
// rhythm editor with a live clash check against everything already booked.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, type TextInputInstance, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { api } from '@/lib/api';
import { cadenceShort, nudgeTime, sessionsBetween } from '@/lib/model';
import { fonts, radius, useTheme } from '@/lib/theme';
import {
  addDays,
  daysBetween,
  hhmm,
  localDate,
  longDate,
  mondayOf,
  MONTHS_LONG,
  MONTHS_SHORT,
  timeToMinutes,
  WEEKDAYS_SHORT,
  weekdayOf,
} from '@/lib/time';
import type { AppState, CommitmentCheck } from '@/lib/types';
import { Card, Chip, DayPills, Icon, IconButton, MiniWeek, T } from '@/ui';
import { ChoiceTile, TimeTile } from './pickers';

// ───────────────────────── deadline
function lastOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function deadlineChoices(today: string): { label: string; date: string }[] {
  const twoWeeks = addDays(today, 14);
  let eom = lastOfMonth(today);
  if (daysBetween(today, eom) < 7) eom = lastOfMonth(addDays(eom, 1));
  const suggested = addDays(today, 51);
  const [, sm, sd] = suggested.split('-').map(Number);
  return [
    { label: 'In 2 weeks', date: twoWeeks },
    { label: `End of ${MONTHS_SHORT[Number(eom.slice(5, 7)) - 1]}`, date: eom },
    { label: `${sd} ${MONTHS_SHORT[sm - 1]}`, date: suggested },
  ];
}

function DayCell({ day, selected, disabled, onPress }: { day: number; selected: boolean; disabled: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const reduced = useReducedMotion();
  const s = useSharedValue(1);
  useEffect(() => {
    if (selected && !reduced) s.value = withSequence(withTiming(0.85, { duration: 60 }), withSpring(1, { damping: 8, stiffness: 220 }));
  }, [reduced, s, selected]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      style={{ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Animated.View
        style={[
          { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? c.button : 'transparent' },
          style,
        ]}
      >
        <T variant="body" color={selected ? c.onButton : disabled ? c.textMuted : c.text} style={{ fontFamily: selected ? fonts.uiBold : fonts.ui }}>
          {day}
        </T>
      </Animated.View>
    </Pressable>
  );
}

export function MonthCalendar({ value, onChange, minDate }: { value: string | null; onChange: (d: string) => void; minDate: string }) {
  const { c } = useTheme();
  const start = value ?? minDate;
  const [month, setMonth] = useState(start.slice(0, 7));
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const days = Number(lastOfMonth(first).slice(8));
  const lead = (weekdayOf(first) + 6) % 7; // Monday first
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
    setMonth(d);
  };
  return (
    <Card style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <IconButton icon="chevronLeft" label="Previous month" tone="clear" onPress={() => shift(-1)} />
        <T variant="cardTitle">{`${MONTHS_LONG[m - 1]} ${y}`}</T>
        <IconButton icon="chevronRight" label="Next month" tone="clear" onPress={() => shift(1)} />
      </View>
      <View style={{ flexDirection: 'row' }}>
        {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => (
          <T key={d} variant="caption" tone="secondary" align="center" style={{ flex: 1, fontSize: 11, fontFamily: fonts.uiMedium }}>
            {d}
          </T>
        ))}
      </View>
      {Array.from({ length: cells.length / 7 }, (_, row) => (
        <View key={row} style={{ flexDirection: 'row' }}>
          {cells.slice(row * 7, row * 7 + 7).map((day, i) => {
            if (!day) return <View key={i} style={{ flex: 1, height: 44 }} />;
            const date = `${month}-${String(day).padStart(2, '0')}`;
            return <DayCell key={i} day={day} selected={date === value} disabled={date < minDate} onPress={() => onChange(date)} />;
          })}
        </View>
      ))}
      <View style={{ height: 1, backgroundColor: c.line, marginTop: 2 }} />
    </Card>
  );
}

export function DeadlineSummary({ today, deadline }: { today: string; deadline: string }) {
  const days = daysBetween(today, deadline);
  const weeks = Math.round(days / 7);
  return (
    <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
      <T variant="h1" style={{ fontSize: 30 }}>{`${days}\n${days === 1 ? 'day' : 'days'}`}</T>
      <T tone="secondary" style={{ flex: 1 }}>
        {`${longDate(deadline)}${weeks >= 2 ? ` · about ${weeks} weeks` : ''}`}
      </T>
    </View>
  );
}

// ───────────────────────── milestones
export interface MilestoneDraft {
  key: string;
  id?: string;
  title: string;
  done?: boolean;
}

let keySeq = 0;
export const newKey = () => `m${Date.now().toString(36)}${(keySeq++).toString(36)}`;

export function MilestoneEditor({ items, onChange }: { items: MilestoneDraft[]; onChange: (items: MilestoneDraft[]) => void }) {
  const { c } = useTheme();
  const [moving, setMoving] = useState<string | null>(null);
  const inputs = useRef<Record<string, TextInputInstance | null>>({});
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <View style={{ gap: 8 }}>
      {items.map((m, i) => (
        <View
          key={m.key}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            minHeight: 56,
            borderRadius: radius.input,
            borderWidth: 1,
            borderColor: moving === m.key ? c.mark : c.line,
            backgroundColor: c.surface,
            paddingLeft: 12,
            paddingRight: 4,
          }}
        >
          <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c.sand, alignItems: 'center', justifyContent: 'center' }}>
            <T variant="caption" style={{ fontFamily: fonts.uiBold }}>
              {i + 1}
            </T>
          </View>
          <TextInput
            ref={(r) => {
              inputs.current[m.key] = r;
            }}
            value={m.title}
            onChangeText={(t) => onChange(items.map((x) => (x.key === m.key ? { ...x, title: t.slice(0, 120) } : x)))}
            placeholder="Describe a step"
            placeholderTextColor={c.textMuted}
            multiline
            style={{ flex: 1, color: c.text, fontFamily: fonts.ui, fontSize: 15, lineHeight: 21, paddingVertical: 10 }}
            accessibilityLabel={`Milestone ${i + 1}`}
          />
          {moving === m.key ? (
            <>
              <IconButton icon="arrowUp" label="Move up" tone="clear" size={36} iconSize={18} onPress={() => move(i, -1)} />
              <IconButton icon="arrowDown" label="Move down" tone="clear" size={36} iconSize={18} onPress={() => move(i, 1)} />
              <IconButton
                icon="trash"
                label="Remove milestone"
                tone="clear"
                size={36}
                iconSize={18}
                onPress={() => {
                  onChange(items.filter((x) => x.key !== m.key));
                  setMoving(null);
                }}
              />
            </>
          ) : null}
          <IconButton
            icon={moving === m.key ? 'check' : 'grip'}
            label={moving === m.key ? 'Done reordering' : 'Reorder or remove'}
            tone="clear"
            size={40}
            iconSize={18}
            onPress={() => setMoving(moving === m.key ? null : m.key)}
          />
        </View>
      ))}
      <Pressable
        onPress={() => {
          const key = newKey();
          onChange([...items, { key, title: '' }]);
          setTimeout(() => inputs.current[key]?.focus(), 50);
        }}
        accessibilityRole="button"
        accessibilityLabel="Add milestone"
        style={{
          minHeight: 52,
          borderRadius: radius.input,
          borderWidth: 1.5,
          borderStyle: 'dashed',
          borderColor: c.lineStrong,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
        }}
      >
        <Icon name="plus" size={18} />
        <T variant="label">Add milestone</T>
      </Pressable>
    </View>
  );
}

// ───────────────────────── rhythm
export interface RhythmDraft {
  weekdays: number[];
  start_time: string;
  duration_min: number;
  lead_min: number;
}

export const DEFAULT_RHYTHM: RhythmDraft = { weekdays: [1, 3, 5], start_time: '20:00', duration_min: 60, lead_min: 10 };
const DURATIONS = [15, 30, 45, 60, 75, 90, 120, 150, 180, 240];
const LEADS = [0, 5, 10, 15, 30];

/** Live clash check for a rhythm over the next 14 days (debounced). */
export function useRhythmCheck(rhythm: RhythmDraft, ignoreGoal?: string) {
  const [result, setResult] = useState<CommitmentCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const key = `${rhythm.weekdays.join(',')}|${rhythm.start_time}|${rhythm.duration_min}`;
  useEffect(() => {
    if (rhythm.weekdays.length === 0) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        // a goal being edited ignores its own sessions: they move with the new rhythm
        const r = await api.checkSlots({
          title: 'check',
          weekdays: rhythm.weekdays,
          start_time: rhythm.start_time,
          duration_min: rhythm.duration_min,
          ignore_goal: ignoreGoal,
        });
        if (!cancelled) setResult(r);
      } catch {
        if (!cancelled) setResult(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { result, checking };
}

export function RhythmEditor({
  state,
  rhythm,
  onChange,
  deadline,
  check,
  checking,
  excludeGoal,
}: {
  state: AppState;
  rhythm: RhythmDraft;
  onChange: (r: RhythmDraft) => void;
  deadline: string;
  check: CommitmentCheck | null;
  checking: boolean;
  excludeGoal?: string;
}) {
  const { c } = useTheme();
  const tz = state.profile.timezone;
  const today = localDate(new Date(), tz);
  const monday = mondayOf(today);
  const startMin = timeToMinutes(rhythm.start_time);
  const existing = useMemo(() => state.blocks.filter((b) => b.goal_id !== excludeGoal || !excludeGoal), [excludeGoal, state.blocks]);
  const clashDays = [...new Set((check?.clashes ?? []).map((x) => weekdayOf(localDate(x.starts_at, tz))))];
  const sessions = sessionsBetween(rhythm.weekdays, today, deadline);
  return (
    <View style={{ gap: 14 }}>
      <DayPills value={rhythm.weekdays} onChange={(weekdays) => onChange({ ...rhythm, weekdays })} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TimeTile label="Starts" value={rhythm.start_time} onChange={(start_time) => onChange({ ...rhythm, start_time })} />
        <ChoiceTile
          label="Lasts"
          title="How long is each session?"
          value={rhythm.duration_min}
          options={DURATIONS}
          display={(v) => (v % 60 === 0 && v >= 120 ? `${v / 60}h` : `${v}m`)}
          onChange={(duration_min) => onChange({ ...rhythm, duration_min })}
        />
        <ChoiceTile
          label="Nudge"
          title="Remind me before each session"
          value={rhythm.lead_min}
          options={LEADS}
          display={(v) => (v === 0 ? 'Off' : `-${v}m`)}
          onChange={(lead_min) => onChange({ ...rhythm, lead_min })}
        />
      </View>
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <T variant="label">How your week looks</T>
          {rhythm.weekdays.length === 0 ? null : checking && !check ? (
            <T variant="caption" tone="secondary">
              Checking…
            </T>
          ) : check && check.clashes.length > 0 ? (
            <Chip tone="outline" icon="alert" label={`${check.clashes.length} clash${check.clashes.length === 1 ? '' : 'es'}`} style={{ borderColor: c.danger }} />
          ) : check ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="check" size={16} color={c.success} />
              <T variant="caption" style={{ fontFamily: fonts.uiBold }}>
                No clashes
              </T>
            </View>
          ) : null}
        </View>
        <MiniWeek
          existing={existing}
          newSlots={rhythm.weekdays.map((weekday) => ({ weekday, startMin, endMin: startMin + rhythm.duration_min }))}
          clashDays={clashDays}
          tz={tz}
          monday={monday}
        />
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: c.mark }} />
            <T variant="caption" tone="secondary">
              New sessions
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: c.lineStrong }} />
            <T variant="caption" tone="secondary">
              Already booked
            </T>
          </View>
        </View>
        {(check?.clashes ?? []).slice(0, 4).map((x) => (
          <T key={x.starts_at} variant="caption" tone="danger">
            {`${WEEKDAYS_SHORT[weekdayOf(localDate(x.starts_at, tz))]} ${hhmm(rhythm.start_time)} clashes with ${x.with.title}`}
          </T>
        ))}
      </Card>
      {rhythm.weekdays.length > 0 ? (
        <T tone="secondary">
          <T style={{ fontFamily: fonts.uiBold }}>{`${sessions} sessions`}</T>
          {` until ${Number(deadline.slice(8))} ${MONTHS_SHORT[Number(deadline.slice(5, 7)) - 1]} · ${cadenceShort(rhythm.weekdays)}${
            rhythm.lead_min > 0 ? ` · nudges at ${nudgeTime(rhythm)} and ${hhmm(rhythm.start_time)}` : ''
          }`}
        </T>
      ) : (
        <T tone="secondary">Pick at least one day.</T>
      )}
    </View>
  );
}
