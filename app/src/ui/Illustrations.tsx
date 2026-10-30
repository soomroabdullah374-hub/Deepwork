// Onboarding and empty-state illustrations.

import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { EASE } from '@/lib/motion';
import { fonts, useTheme } from '@/lib/theme';
import { DeepWorkMark } from './DeepWorkMark';
import { T } from './Text';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** A ring partly drawn, a dotted path and a floating flag. */
export function RingFlag({ size = 200, track }: { size?: number; track?: string }) {
  const { c } = useTheme();
  const reduced = useReducedMotion();
  const draw = useSharedValue(reduced ? 1 : 0);
  const float = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    draw.value = withTiming(1, { duration: 900, easing: EASE });
    float.value = withRepeat(withSequence(withTiming(-4, { duration: 1400 }), withTiming(0, { duration: 1400 })), -1);
  }, [draw, float, reduced]);
  const r = 38;
  const circ = 2 * Math.PI * r;
  const arc = useAnimatedProps(() => ({ strokeDashoffset: circ - circ * 0.33 * draw.value }));
  const flag = useAnimatedStyle(() => ({ transform: [{ translateY: float.value }] }));
  return (
    <View style={{ width: size * 1.25, height: size, alignItems: 'flex-start', justifyContent: 'center' }} accessibilityElementsHidden>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Circle cx={50} cy={50} r={r} stroke={track ?? c.sand} strokeWidth={14} fill="none" />
        <AnimatedCircle
          cx={50}
          cy={50}
          r={r}
          stroke={c.mark}
          strokeWidth={14}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circ} ${circ}`}
          animatedProps={arc}
          transform="rotate(-90 50 50)"
        />
        <Circle cx={50} cy={50} r={3.5} fill={c.text} />
      </Svg>
      <Svg width={size * 0.4} height={size * 0.5} style={{ position: 'absolute', left: size * 0.86, top: size * 0.12 }}>
        <Line x1={0} y1={size * 0.36} x2={size * 0.22} y2={size * 0.1} stroke={c.textMuted} strokeWidth={2} strokeDasharray="2 5" strokeLinecap="round" />
      </Svg>
      <Animated.View style={[{ position: 'absolute', left: size * 1.06, top: size * 0.0 }, flag]}>
        <Svg width={size * 0.18} height={size * 0.26} viewBox="0 0 18 26">
          <Line x1={2} y1={1} x2={2} y2={25} stroke={c.text} strokeWidth={2} strokeLinecap="round" />
          <Path d="M3 2h13l-3.5 4.5L16 11H3z" fill={c.mark} />
        </Svg>
      </Animated.View>
    </View>
  );
}

/** Seven day columns with three Kiln blocks dropping in at the same height. */
export function WeekColumns() {
  const { c } = useTheme();
  const reduced = useReducedMotion();
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const active = [0, 2, 5];
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end' }} accessibilityElementsHidden>
      {days.map((d, i) => (
        <View key={i} style={{ alignItems: 'center', gap: 8 }}>
          <View style={{ width: 30, height: 180, borderRadius: 15, backgroundColor: c.surface, overflow: 'hidden' }}>
            {active.includes(i) ? <Drop index={active.indexOf(i)} reduced={reduced} color={c.mark} /> : null}
          </View>
          <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono }}>
            {d}
          </T>
        </View>
      ))}
    </View>
  );
}

function Drop({ index, reduced, color }: { index: number; reduced: boolean; color: string }) {
  const p = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!reduced) p.value = withDelay(200 + index * 140, withSpring(1, { damping: 12, stiffness: 140 }));
  }, [index, p, reduced]);
  const style = useAnimatedStyle(() => ({ opacity: Math.min(1, p.value * 1.5), transform: [{ translateY: (1 - p.value) * -90 }] }));
  return <Animated.View style={[{ position: 'absolute', top: 96, left: 3, right: 3, height: 36, borderRadius: 8, backgroundColor: color }, style]} />;
}

/** A sample reminder with Start / Snooze buttons. */
export function ReminderCard() {
  const { c } = useTheme();
  return (
    <View style={{ width: 290, gap: 10 }} accessibilityElementsHidden>
      <View style={{ borderRadius: 18, backgroundColor: c.surface, padding: 14, flexDirection: 'row', gap: 12, borderWidth: 1, borderColor: c.line }}>
        <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: c.button, alignItems: 'center', justifyContent: 'center' }}>
          <DeepWorkMark size={24} color="#FAF9F5" />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T variant="caption" style={{ fontFamily: fonts.uiBold }}>
              DeepWork
            </T>
            <T variant="caption" tone="secondary">
              19:50
            </T>
          </View>
          <T variant="label">Time for your deep work block.</T>
          <T variant="caption" tone="secondary">
            AI Agent project starts at 20:00.
          </T>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 18 }}>
        {['Start', 'Snooze 10m'].map((l) => (
          <View key={l} style={{ flex: 1, borderRadius: 10, backgroundColor: c.surface, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: c.line }}>
            <T variant="caption" style={{ fontFamily: fonts.uiBold }}>
              {l}
            </T>
          </View>
        ))}
      </View>
    </View>
  );
}
