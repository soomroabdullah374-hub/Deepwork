// The Today ribbon (06–24), the My schedule week grid and the rhythm mini week.

import { type ReactNode, useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { EASE } from '@/lib/motion';
import { dayRibbon, holdsTime, shortLabel } from '@/lib/model';
import { fonts, useTheme } from '@/lib/theme';
import { addDays, localDate, localMinutes, MONDAY_FIRST, WEEKDAY_LETTERS } from '@/lib/time';
import type { Block } from '@/lib/types';
import { T } from './Text';

function Blink({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (!reduced) o.value = withRepeat(withTiming(0.25, { duration: 900 }), -1, true);
  }, [o, reduced]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

export function DayRibbon({
  blocks,
  now,
  tz,
  onPressBlock,
}: {
  blocks: Block[];
  now: Date;
  tz: string;
  onPressBlock?: (b: Block) => void;
}) {
  const { c, scheme } = useTheme();
  const r = dayRibbon(blocks, now, tz);
  const ticks = ['06', '09', '12', '15', '18', '21', '24'];
  const trackDone = scheme === 'light' ? '#D9D6CA' : '#4A4945';
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T variant="label" style={{ fontFamily: fonts.uiBold }}>
          Your day
        </T>
        <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono }}>
          now {r.nowLabel}
        </T>
      </View>
      <View style={{ height: 36, justifyContent: 'center' }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: c.sand, overflow: 'hidden' }}>
          <View style={{ width: `${r.now * 100}%`, height: 6, backgroundColor: trackDone }} />
        </View>
        {r.items.map(({ block, left, right }) => {
          const done = block.status === 'done';
          const commitment = block.kind === 'commitment';
          const bg = done ? c.success : commitment ? c.lineStrong : block.status === 'missed' ? c.surface : c.mark;
          return (
            <Pressable
              key={block.id}
              onPress={() => onPressBlock?.(block)}
              accessibilityRole="button"
              accessibilityLabel={`${block.title}, ${block.status}`}
              style={{
                position: 'absolute',
                left: `${left * 100}%`,
                width: `${Math.max(right - left, 0.035) * 100}%`,
                height: 22,
                top: 7,
                borderRadius: 6,
                backgroundColor: bg,
                borderWidth: block.status === 'missed' ? 1.5 : 0,
                borderColor: c.danger,
                borderStyle: 'dashed',
              }}
            />
          );
        })}
        <View style={{ position: 'absolute', left: `${r.now * 100}%`, top: 0, bottom: 0, width: 2, marginLeft: -1, backgroundColor: c.text }} />
        <View style={{ position: 'absolute', left: `${r.now * 100}%`, top: -4, marginLeft: -5 }}>
          <Blink>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.text }} />
          </Blink>
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {ticks.map((t) => (
          <T key={t} variant="caption" tone="secondary" style={{ fontFamily: fonts.mono, fontSize: 11 }}>
            {t}
          </T>
        ))}
      </View>
    </View>
  );
}

/** One dropping block for the week grid (staggered). */
function DropIn({ index, children }: { index: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!reduced) p.value = withDelay(80 + index * 40, withTiming(1, { duration: 320, easing: EASE }));
  }, [index, p, reduced]);
  const style = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: (1 - p.value) * -8 }] }));
  return <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, style]} pointerEvents="box-none">{children}</Animated.View>;
}

export function WeekGrid({
  blocks,
  monday,
  today,
  tz,
  onPressBlock,
  startHour = 8,
  endHour = 22,
  hourHeight = 28,
}: {
  blocks: Block[];
  monday: string;
  today: string;
  tz: string;
  onPressBlock?: (b: Block) => void;
  startHour?: number;
  endHour?: number;
  hourHeight?: number;
}) {
  const { c, scheme } = useTheme();
  const height = (endHour - startHour) * hourHeight;
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const y = (min: number) => ((Math.min(Math.max(min, startHour * 60), endHour * 60) - startHour * 60) / 60) * hourHeight;
  let index = 0;
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      <View style={{ width: 22, height }}>
        {Array.from({ length: Math.floor((endHour - startHour) / 2) + 1 }, (_, i) => startHour + i * 2).map((h) => (
          <T
            key={h}
            variant="caption"
            tone="secondary"
            style={{ position: 'absolute', top: y(h * 60) - 7, fontFamily: fonts.mono, fontSize: 10 }}
          >
            {String(h).padStart(2, '0')}
          </T>
        ))}
      </View>
      <View style={{ flex: 1, height, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface, overflow: 'hidden', flexDirection: 'row' }}>
        {Array.from({ length: Math.floor((endHour - startHour) / 2) }, (_, i) => (
          <View
            key={i}
            style={{ position: 'absolute', left: 0, right: 0, top: y((startHour + (i + 1) * 2) * 60), borderTopWidth: 1, borderColor: c.line, borderStyle: 'dashed' }}
          />
        ))}
        {days.map((d) => {
          const mine = blocks.filter((b) => holdsTime(b) && localDate(b.starts_at, tz) === d);
          return (
            <View key={d} style={{ flex: 1, backgroundColor: d === today ? (scheme === 'light' ? '#F0EEE6' : '#262523') : 'transparent' }}>
              {mine.map((b) => {
                const top = y(localMinutes(b.starts_at, tz));
                const endMin = localDate(b.ends_at, tz) === d ? localMinutes(b.ends_at, tz) : 24 * 60;
                const h = Math.max(y(endMin) - top, 14);
                const session = b.kind === 'session';
                const i = index++;
                return (
                  <DropIn key={b.id} index={i}>
                    <Pressable
                      onPress={() => onPressBlock?.(b)}
                      accessibilityRole="button"
                      accessibilityLabel={`${b.title}`}
                      style={{
                        position: 'absolute',
                        top,
                        height: h,
                        left: 2,
                        right: 2,
                        borderRadius: 6,
                        padding: 3,
                        backgroundColor: session ? c.button : c.sand,
                        borderWidth: session ? 0 : 1,
                        borderColor: c.lineStrong,
                        opacity: b.status === 'missed' ? 0.55 : 1,
                      }}
                    >
                      <T numberOfLines={1} style={{ fontFamily: fonts.uiBold, fontSize: 9, lineHeight: 11, color: session ? '#FAF9F5' : c.text }}>
                        {shortLabel(b.title)}
                      </T>
                    </Pressable>
                  </DropIn>
                );
              })}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Rhythm step: 7 columns 08–22, existing blocks grey, the new sessions in Kiln. */
export function MiniWeek({
  existing,
  newSlots,
  clashDays,
  tz,
  monday,
}: {
  existing: Block[];
  newSlots: { weekday: number; startMin: number; endMin: number }[];
  clashDays: number[];
  tz: string;
  monday: string;
}) {
  const { c } = useTheme();
  const H = 80;
  const y = (m: number) => ((Math.min(Math.max(m, 8 * 60), 22 * 60) - 8 * 60) / (14 * 60)) * H;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {MONDAY_FIRST.map((wd, i) => {
          const date = addDays(monday, i);
          const mine = existing.filter((b) => holdsTime(b) && localDate(b.starts_at, tz) === date);
          const slot = newSlots.find((s) => s.weekday === wd);
          const clash = clashDays.includes(wd);
          return (
            <View key={wd} style={{ flex: 1, height: H, borderRadius: 8, backgroundColor: c.surfaceSunk, overflow: 'hidden' }}>
              {mine.map((b) => (
                <View
                  key={b.id}
                  style={{ position: 'absolute', left: 0, right: 0, top: y(localMinutes(b.starts_at, tz)), height: Math.max(y(localMinutes(b.ends_at, tz)) - y(localMinutes(b.starts_at, tz)), 4), backgroundColor: c.lineStrong }}
                />
              ))}
              {slot ? (
                <DropIn index={i}>
                  <View
                    style={{
                      position: 'absolute',
                      left: 2,
                      right: 2,
                      top: y(slot.startMin),
                      height: Math.max(y(slot.endMin) - y(slot.startMin), 6),
                      borderRadius: 4,
                      backgroundColor: clash ? 'transparent' : c.mark,
                      borderWidth: clash ? 1.5 : 0,
                      borderColor: c.danger,
                      borderStyle: 'dashed',
                    }}
                  />
                </DropIn>
              ) : null}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {MONDAY_FIRST.map((wd) => (
          <T key={wd} variant="caption" tone="secondary" align="center" style={{ flex: 1, fontFamily: fonts.mono, fontSize: 11 }}>
            {WEEKDAY_LETTERS[wd]}
          </T>
        ))}
      </View>
    </View>
  );
}
