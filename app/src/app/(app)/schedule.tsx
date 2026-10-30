// [16] My schedule: the fixed week, Monday to Sunday, 08–22. Sessions only go in the gaps.

import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { overlapCount } from '@/lib/model';
import { useChange, useLoadedState, useNow } from '@/lib/queries';
import { fonts, useTheme } from '@/lib/theme';
import { addDays, dayLabel, localDate, localTime, localToUtc, mondayOf, WEEKDAYS_SHORT } from '@/lib/time';
import type { Block } from '@/lib/types';
import { Button, Chip, Icon, IconButton, Screen, Sheet, T, WeekGrid } from '@/ui';

export default function Schedule() {
  const { c, scheme } = useTheme();
  const state = useLoadedState();
  const now = useNow(60_000);
  const tz = state.profile.timezone;
  const today = localDate(now, tz);
  const thisMonday = mondayOf(today);
  const [monday, setMonday] = useState(thisMonday);
  const [selected, setSelected] = useState<Block | null>(null);
  const inState = monday >= addDays(thisMonday, -7) && monday <= addDays(thisMonday, 7);
  const other = useQuery({
    queryKey: ['blocks', monday],
    enabled: !inState,
    queryFn: () => api.blocks(localToUtc(monday, tz), localToUtc(addDays(monday, 7), tz)),
  });
  const blocks = inState ? state.blocks : (other.data ?? []);
  const week = blocks.filter((b) => {
    const d = localDate(b.starts_at, tz);
    return d >= monday && d <= addDays(monday, 6);
  });
  const clashes = overlapCount(week) + (monday === thisMonday ? state.conflicts.length : 0);
  const cancel = useChange((b: Block) => (b.kind === 'session' ? api.blockAction(b.id, 'cancel') : api.blockAction(b.id, 'cancel')));
  const removeSeries = useChange((id: string) => api.deleteCommitment(id));
  const commitment = selected?.commitment_id ? state.commitments.find((x) => x.id === selected.commitment_id) : undefined;

  return (
    <Screen
      footer={<Button label="Add a commitment" icon="plus" onPress={() => router.push('/commitment')} />}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.navigate('/settings'))} />
        <Chip
          icon={clashes ? 'alert' : 'check'}
          tone="outline"
          label={clashes ? `${clashes} clash${clashes === 1 ? '' : 'es'}` : 'No overlaps this week'}
          style={clashes ? { borderColor: c.danger } : undefined}
        />
      </View>
      <View style={{ gap: 4 }}>
        <T variant="h1">My schedule</T>
        <T tone="secondary">Your fixed week. Sessions only go in the gaps.</T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <IconButton icon="chevronLeft" label="Previous week" tone="clear" size={32} iconSize={16} onPress={() => setMonday(addDays(monday, -7))} />
        <View style={{ flex: 1, flexDirection: 'row', marginLeft: 0 }}>
          {Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((d) => {
            const isToday = d === today;
            return (
              <View key={d} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
                <T variant="caption" tone={isToday ? 'mark' : 'secondary'} style={{ fontSize: 10, fontFamily: fonts.uiBold }}>
                  {WEEKDAYS_SHORT[new Date(`${d}T12:00:00Z`).getUTCDay()].toUpperCase()}
                </T>
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: isToday ? (scheme === 'light' ? c.inverseSurface : c.inverseSurface) : 'transparent',
                  }}
                >
                  <T variant="label" color={isToday ? (scheme === 'light' ? '#FAF9F5' : '#141413') : c.text} style={{ fontSize: 13 }}>
                    {Number(d.slice(8))}
                  </T>
                </View>
              </View>
            );
          })}
        </View>
        <IconButton icon="chevronRight" label="Next week" tone="clear" size={32} iconSize={16} onPress={() => setMonday(addDays(monday, 7))} />
      </View>
      <WeekGrid blocks={week} monday={monday} today={today} tz={tz} onPressBlock={setSelected} />
      <View style={{ flexDirection: 'row', gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: c.button }} />
          <T variant="caption" tone="secondary">
            DeepWork sessions
          </T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: c.sand, borderWidth: 1, borderColor: c.lineStrong }} />
          <T variant="caption" tone="secondary">
            Your commitments
          </T>
        </View>
      </View>

      <Sheet visible={Boolean(selected)} onClose={() => setSelected(null)}>
        {selected ? (
          <>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <Icon name={selected.kind === 'session' ? 'target' : 'calendar'} size={22} color={c.mark} />
              <View style={{ flex: 1 }}>
                <T variant="h2">{selected.title}</T>
                <T variant="caption" tone="secondary">{`${dayLabel(localDate(selected.starts_at, tz))} · ${localTime(selected.starts_at, tz)}–${localTime(selected.ends_at, tz)} · ${selected.status}`}</T>
              </View>
            </View>
            {selected.kind === 'session' ? (
              <>
                {selected.goal_id ? (
                  <Button label="Open goal" variant="secondary" onPress={() => { const g = selected.goal_id; setSelected(null); router.push(`/goal/${g}`); }} />
                ) : null}
                {selected.status === 'planned' || selected.status === 'snoozed' || selected.status === 'missed' ? (
                  <>
                    <Button label="Move to a free slot" variant="secondary" onPress={() => { const id = selected.id; setSelected(null); router.push(`/move/${id}`); }} />
                    <Button
                      label="Cancel this session"
                      variant="danger"
                      loading={cancel.isPending}
                      onPress={() =>
                        cancel.mutate(selected, {
                          onSuccess: () => {
                            showBanner('Session cancelled.');
                            setSelected(null);
                          },
                          onError: (e) => showBanner(errorMessage(e), 'danger'),
                        })
                      }
                    />
                  </>
                ) : null}
              </>
            ) : (
              <>
                {commitment ? (
                  <Button label="Edit commitment" variant="secondary" onPress={() => { setSelected(null); router.push({ pathname: '/commitment', params: { id: commitment.id } }); }} />
                ) : null}
                {selected.status !== 'cancelled' ? (
                  <Button
                    label="Remove just this one"
                    variant="secondary"
                    loading={cancel.isPending}
                    onPress={() =>
                      cancel.mutate(selected, {
                        onSuccess: () => {
                          showBanner('Removed for this day.');
                          setSelected(null);
                        },
                        onError: (e) => showBanner(errorMessage(e), 'danger'),
                      })
                    }
                  />
                ) : null}
                {commitment ? (
                  <Button
                    label="Delete every week"
                    variant="danger"
                    loading={removeSeries.isPending}
                    onPress={() =>
                      removeSeries.mutate(commitment.id, {
                        onSuccess: () => {
                          showBanner(`${commitment.title} removed.`);
                          setSelected(null);
                        },
                        onError: (e) => showBanner(errorMessage(e), 'danger'),
                      })
                    }
                  />
                ) : null}
              </>
            )}
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}
