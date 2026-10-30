// [17] Add (or edit) a commitment, checked for clashes on every selected day as you pick.

import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { DateTile, DurationTile, durationLabel, TimeTile } from '@/features/pickers';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { daysPhrase, holdsTime } from '@/lib/model';
import { useShake } from '@/lib/motion';
import { useChange, useLoadedState } from '@/lib/queries';
import { fonts, radius, useTheme } from '@/lib/theme';
import {
  addDays,
  dayLabel,
  hhmm,
  lengthUntil,
  localDate,
  localMinutes,
  minutesToTime,
  timeToMinutes,
  WEEKDAYS_LONG,
  weekdayOf,
} from '@/lib/time';
import type { CommitmentCheck } from '@/lib/types';
import { Button, Card, Chip, DayPills, Field, Icon, Screen, Segmented, T, TopBar } from '@/ui';

const LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240, 480];

export default function CommitmentScreen() {
  const { c } = useTheme();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const state = useLoadedState();
  const tz = state.profile.timezone;
  const existing = id ? state.commitments.find((x) => x.id === id) : undefined;
  const today = localDate(new Date(), tz);

  const [title, setTitle] = useState(existing?.title ?? '');
  const [weekly, setWeekly] = useState<'weekly' | 'once'>(existing?.one_off_date ? 'once' : 'weekly');
  const [days, setDays] = useState<number[]>(
    existing ? (existing.one_off_date ? [weekdayOf(existing.one_off_date)] : existing.weekdays) : [weekdayOf(today)],
  );
  const [start, setStart] = useState(existing ? hhmm(existing.start_time) : '18:00');
  const [length, setLength] = useState(existing?.duration_min ?? 60);
  // a one-time commitment's date; the first default is the next time `start` comes round
  const [onceDate, setOnceDate] = useState<string | null>(existing?.one_off_date ?? null);
  const [check, setCheck] = useState<CommitmentCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const { style: shakeStyle, shake } = useShake();
  const save = useChange(() =>
    api.saveCommitment(
      {
        title: title.trim(),
        weekdays: weekly === 'weekly' ? days : [],
        start_time: start,
        duration_min: length,
        one_off_date: weekly === 'once' ? oneOffDate : null,
      },
      existing?.id,
    ),
  );
  const remove = useChange(() => api.deleteCommitment(existing!.id));

  const oneOffDate = useMemo(
    () => onceDate ?? (timeToMinutes(start) > localMinutes(new Date(), tz) ? today : addDays(today, 1)),
    [onceDate, start, today, tz],
  );
  const hasDays = weekly === 'once' || days.length > 0;

  const key = `${weekly}|${days.join(',')}|${start}|${length}|${oneOffDate}`;
  useEffect(() => {
    if (!hasDays) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.checkSlots({
          title: title || 'check',
          weekdays: weekly === 'weekly' ? days : [],
          start_time: start,
          duration_min: length,
          one_off_date: weekly === 'once' ? oneOffDate : null,
          id: existing?.id,
        });
        if (cancelled) return;
        setCheck(r);
        if (r.clashes.length) {
          shake();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
        }
      } catch {
        if (!cancelled) setCheck(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const startMin = timeToMinutes(start);
  const chips = [-120, -60, 0, 60, 120].map((d) => minutesToTime(Math.min(Math.max(startMin + d, 0), 23 * 60)));
  const previewDay = days[0] ?? weekdayOf(today);
  const previewDate = weekly === 'once' ? oneOffDate : (() => {
    for (let i = 0; i < 7; i++) if (weekdayOf(addDays(today, i)) === previewDay) return addDays(today, i);
    return today;
  })();
  const winFrom = Math.max(0, Math.floor(startMin / 60) - 3) * 60;
  const winTo = Math.min(24 * 60, winFrom + 7 * 60);
  const x = (m: number) => `${((Math.min(Math.max(m, winFrom), winTo) - winFrom) / (winTo - winFrom)) * 100}%` as const;
  const others = state.blocks.filter((b) => holdsTime(b) && localDate(b.starts_at, tz) === previewDate && b.commitment_id !== existing?.id);
  const clash = (check?.clashes.length ?? 0) > 0;
  const canSave = title.trim().length > 0 && hasDays && !clash && !checking && Boolean(check);
  const nextDay = startMin + length >= 24 * 60;
  const endText = `${minutesToTime(startMin + length)}${nextDay ? ' (next day)' : ''}`;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        footer={
          <>
            <Button
              label={clash ? 'Pick a free time to save' : existing ? 'Save changes' : 'Save commitment'}
              disabled={!canSave}
              loading={save.isPending}
              onPress={() =>
                save.mutate(undefined, {
                  onSuccess: () => {
                    showBanner(existing ? 'Commitment updated.' : `${title.trim()} added. Sessions will work around it.`);
                    router.back();
                  },
                  onError: (e) => showBanner(errorMessage(e), 'danger'),
                })
              }
            />
            {existing ? (
              <Button
                label="Delete commitment"
                variant="link"
                style={{ alignSelf: 'center' }}
                loading={remove.isPending}
                onPress={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      showBanner(`${existing.title} removed.`);
                      router.back();
                    },
                    onError: (e) => showBanner(errorMessage(e), 'danger'),
                  })
                }
              />
            ) : null}
          </>
        }
      >
        <TopBar close />
        <View style={{ gap: 6 }}>
          <T variant="h1">{existing ? 'Edit commitment' : 'Add a commitment'}</T>
          <T tone="secondary">Something fixed in your week. Nothing can be booked on top of it.</T>
        </View>
        <Field label="Name" value={title} onChangeText={(t) => setTitle(t.slice(0, 80))} placeholder="Gym, class, work…" autoFocus={!existing} />
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T variant="label">Day</T>
            <Segmented
              compact
              value={weekly}
              onChange={setWeekly}
              options={[
                { value: 'weekly', label: 'Every week' },
                { value: 'once', label: 'Once' },
              ]}
            />
          </View>
          {weekly === 'weekly' ? (
            <DayPills value={days} onChange={setDays} tone="ink" />
          ) : (
            <DateTile label="Date" value={oneOffDate} minimum={today} maximum={addDays(today, 365)} onChange={setOnceDate} />
          )}
        </View>
        <View style={{ gap: 8 }}>
          <T variant="label">
            Time
            <T variant="label" tone="secondary" style={{ fontFamily: fonts.ui }}>{` · ${start} to ${endText} · ${durationLabel(length)}`}</T>
          </T>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {chips.map((t) => (
              <Chip key={t} label={t} mono selected={t === start} onPress={() => setStart(t)} style={{ flex: 1, paddingHorizontal: 4 }} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TimeTile label="Starts" title="When does it start?" value={start} onChange={setStart} />
            <TimeTile
              label="Ends"
              title="When does it end?"
              value={minutesToTime(startMin + length)}
              note={nextDay ? 'next day' : undefined}
              onChange={(end) => setLength(Math.max(5, lengthUntil(start, end)))}
            />
            <DurationTile label="Lasts" title="How long?" value={length} presets={LENGTHS} min={5} max={24 * 60} onChange={setLength} />
          </View>
        </View>

        <Card style={{ gap: 10 }}>
          <T variant="label">{`Your ${WEEKDAYS_LONG[weekdayOf(previewDate)]}`}</T>
          <View style={{ height: 34, borderRadius: 8, backgroundColor: c.surfaceSunk }}>
            {others.map((b) => {
              const s = localMinutes(b.starts_at, tz);
              const e = localDate(b.ends_at, tz) === previewDate ? localMinutes(b.ends_at, tz) : 24 * 60;
              if (e <= winFrom || s >= winTo) return null;
              const hit = check?.clashes.some((cl) => cl.with.id === b.id);
              return (
                <View
                  key={b.id}
                  style={{ position: 'absolute', top: 3, bottom: 3, left: x(s), width: `${((Math.min(e, winTo) - Math.max(s, winFrom)) / (winTo - winFrom)) * 100}%`, borderRadius: 6, backgroundColor: b.kind === 'session' ? c.button : c.lineStrong, borderWidth: hit ? 2 : 0, borderColor: c.danger, paddingHorizontal: 4, justifyContent: 'center' }}
                >
                  <T numberOfLines={1} style={{ fontSize: 10, fontFamily: fonts.uiBold, color: b.kind === 'session' ? '#FAF9F5' : c.text }}>
                    {b.title}
                  </T>
                </View>
              );
            })}
          </View>
          <Animated.View style={[{ height: 34, borderRadius: 8, backgroundColor: c.surfaceSunk }, shakeStyle]}>
            <View
              style={{
                position: 'absolute',
                top: 3,
                bottom: 3,
                left: x(startMin),
                width: `${((Math.min(startMin + length, winTo) - Math.max(startMin, winFrom)) / (winTo - winFrom)) * 100}%`,
                borderRadius: 6,
                backgroundColor: clash ? 'transparent' : c.inverseSurface,
                borderWidth: clash ? 2 : 0,
                borderStyle: 'dashed',
                borderColor: c.danger,
                paddingHorizontal: 4,
                justifyContent: 'center',
              }}
            >
              <T numberOfLines={1} style={{ fontSize: 10, fontFamily: fonts.uiBold, color: clash ? c.danger : c.inverseSurface === '#141413' ? '#FAF9F5' : '#141413' }}>
                {title.trim() || 'New'}
              </T>
            </View>
          </Animated.View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            {Array.from({ length: (winTo - winFrom) / 60 + 1 }, (_, i) => winFrom / 60 + i).map((h) => (
              <T key={h} variant="caption" tone="secondary" style={{ fontFamily: fonts.mono, fontSize: 10 }}>
                {String(h).padStart(2, '0')}
              </T>
            ))}
          </View>
        </Card>

        {!hasDays ? (
          <T tone="secondary">Pick at least one day.</T>
        ) : checking && !check ? (
          <T tone="secondary">Checking your week…</T>
        ) : clash ? (
          <View style={{ borderRadius: radius.input, borderWidth: 1, borderColor: c.danger, padding: 14, gap: 6 }} accessibilityLiveRegion="polite">
            {check!.clashes.slice(0, 4).map((cl) => (
              <View key={cl.starts_at} style={{ flexDirection: 'row', gap: 8 }}>
                <Icon name="alert" size={18} color={c.danger} />
                <T variant="bodySm" style={{ flex: 1 }}>
                  <T variant="bodySm" tone="danger" style={{ fontFamily: fonts.uiBold }}>
                    That time is taken.
                  </T>
                  {cl.message.replace('That time is taken.', '')}
                </T>
              </View>
            ))}
            {check!.clashes.length > 4 ? <T variant="caption" tone="secondary">{`and ${check!.clashes.length - 4} more`}</T> : null}
          </View>
        ) : check ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Icon name="check" size={18} color={c.success} />
            <T variant="bodySm">
              <T variant="bodySm" style={{ fontFamily: fonts.uiBold }}>
                No clash.
              </T>
              {` ${weekly === 'weekly' ? daysPhrase(days) : dayLabel(oneOffDate)}, ${start}–${endText}`}
            </T>
          </View>
        ) : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}
