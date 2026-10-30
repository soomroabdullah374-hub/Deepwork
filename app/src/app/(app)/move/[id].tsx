// [18] Move missed session: free slots only (at least the session length, next 7 days),
// each with a one-line reason; the usual time shows struck through when it's taken.

import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { useChange, useLoadedState } from '@/lib/queries';
import { fonts, radius, useTheme } from '@/lib/theme';
import { dayLabel, localDate, localTime, minutesBetween, WEEKDAYS_LONG, WEEKDAYS_SHORT, weekdayOf } from '@/lib/time';
import { Button, Icon, Sheet, T } from '@/ui';

export default function MoveSession() {
  const { c } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLoadedState();
  const tz = state.profile.timezone;
  const block = state.blocks.find((b) => b.id === id);
  const [visible, setVisible] = useState(true);
  const slots = useQuery({ queryKey: ['free-slots', id], queryFn: () => api.freeSlotsFor(id, 7), enabled: Boolean(block) });
  const free = (slots.data?.slots ?? []).filter((s) => !s.taken);
  const [picked, setPicked] = useState<string | null>(null);
  const move = useChange((starts_at: string) => api.blockAction(id, 'move', { starts_at }));

  useEffect(() => {
    if (!picked && free[0]) setPicked(free[0].starts_at);
  }, [free, picked]);

  const close = () => {
    setVisible(false);
    setTimeout(() => router.back(), 280);
  };

  if (!block) {
    return (
      <Sheet visible={visible} onClose={close}>
        <T variant="h2">That session is gone.</T>
        <Button label="Close" variant="secondary" onPress={close} />
      </Sheet>
    );
  }
  const day = localDate(block.starts_at, tz);
  const minutes = minutesBetween(block.starts_at, block.ends_at);
  const chosen = free.find((s) => s.starts_at === picked);
  const chosenLabel = chosen ? `${WEEKDAYS_SHORT[weekdayOf(localDate(chosen.starts_at, tz))]} ${localTime(chosen.starts_at, tz)}` : '';

  return (
    <Sheet visible={visible} onClose={close}>
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: c.inverseSurface, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="retry" size={22} color={c.inverseSurface === '#141413' ? '#FAF9F5' : '#141413'} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="h2">{`Move ${WEEKDAYS_LONG[weekdayOf(day)]}'s session`}</T>
          <T variant="caption" tone="secondary">{`${state.profile.hide_titles ? 'Focus session' : block.title} · ${minutes} min · free slots only`}</T>
        </View>
      </View>
      {slots.isLoading ? (
        <ActivityIndicator color={c.mark} style={{ marginVertical: 24 }} />
      ) : slots.error ? (
        <T tone="danger">{errorMessage(slots.error)}</T>
      ) : (slots.data?.slots ?? []).length === 0 ? (
        <T tone="secondary">No free slot of {minutes} minutes in the next 7 days. Try freeing up an evening.</T>
      ) : (
        <View style={{ gap: 8 }}>
          {(slots.data?.slots ?? []).map((s) => {
            const date = localDate(s.starts_at, tz);
            const on = s.starts_at === picked && !s.taken;
            return (
              <Pressable
                key={s.starts_at}
                disabled={Boolean(s.taken)}
                onPress={() => setPicked(s.starts_at)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled: Boolean(s.taken) }}
                accessibilityLabel={`${dayLabel(date)} ${localTime(s.starts_at, tz)}, ${s.reason}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 60,
                  paddingHorizontal: 14,
                  borderRadius: radius.input,
                  borderWidth: on ? 2 : 1,
                  borderStyle: s.taken ? 'dashed' : 'solid',
                  borderColor: on ? c.button : c.line,
                  backgroundColor: s.taken ? c.surfaceSunk : c.surface,
                }}
              >
                {s.taken ? (
                  <Icon name="ban" size={20} color={c.textSecondary} />
                ) : (
                  <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? c.button : c.lineStrong, alignItems: 'center', justifyContent: 'center' }}>
                    {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.button }} /> : null}
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <T variant="label" tone={s.taken ? 'secondary' : 'text'} style={{ textDecorationLine: s.taken ? 'line-through' : 'none', fontSize: 15 }}>
                    {dayLabel(date)}
                  </T>
                  <T variant="caption" tone="secondary">
                    {s.reason}
                  </T>
                </View>
                <T variant="time" tone={s.taken ? 'secondary' : 'text'} style={{ fontFamily: fonts.monoMedium }}>
                  {localTime(s.starts_at, tz)}
                </T>
              </Pressable>
            );
          })}
        </View>
      )}
      <Button
        label={chosen ? `Move to ${chosenLabel}` : 'Pick a free slot'}
        disabled={!chosen}
        loading={move.isPending}
        onPress={() =>
          chosen &&
          move.mutate(chosen.starts_at, {
            onSuccess: () => {
              showBanner(`Moved to ${chosenLabel}.`);
              close();
            },
            onError: (e) => showBanner(errorMessage(e), 'danger'),
          })
        }
      />
      <Button label="Not now" variant="link" style={{ alignSelf: 'center' }} onPress={close} />
    </Sheet>
  );
}
