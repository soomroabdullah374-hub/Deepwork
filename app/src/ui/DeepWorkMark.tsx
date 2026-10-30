// The DeepWork mark: an 80 % ring drawn clockwise from 12 o'clock and a dot in the gap.
// `animated` draws the arc (900 ms) and then pops the dot.

import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { EASE } from '@/lib/motion';
import { fonts, useTheme } from '@/lib/theme';
import { T } from './Text';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const R = 38;
const C = 2 * Math.PI * R;
const ARC = 0.8 * C;

export function DeepWorkMark({
  size = 28,
  color,
  animated = false,
  onDrawn,
}: {
  size?: number;
  color?: string;
  animated?: boolean;
  onDrawn?: () => void;
}) {
  const { c } = useTheme();
  const reduced = useReducedMotion();
  const tone = color ?? c.mark;
  const draw = useSharedValue(animated && !reduced ? 0 : 1);
  const dot = useSharedValue(animated && !reduced ? 0 : 1);
  useEffect(() => {
    if (!animated || reduced) {
      onDrawn?.();
      return;
    }
    draw.value = withTiming(1, { duration: 900, easing: EASE });
    dot.value = withDelay(850, withSpring(1, { damping: 9, stiffness: 180 }));
    const t = setTimeout(() => onDrawn?.(), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animated, reduced]);
  const small = size < 20;
  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: ARC * (1 - draw.value) }));
  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value > 0.01 ? 1 : 0, transform: [{ scale: dot.value }] }));
  const r = small ? 36 : 38;
  return (
    <View style={{ width: size, height: size }} accessible accessibilityRole="image" accessibilityLabel="DeepWork">
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <AnimatedCircle
          cx={50}
          cy={50}
          r={r}
          stroke={tone}
          strokeWidth={small ? 18 : 15}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${ARC} ${C}`}
          animatedProps={ringProps}
          transform="rotate(-90 50 50)"
        />
      </Svg>
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: ((small ? 28.8 : 27.7) / 100) * size - ((small ? 9 : 7.5) / 100) * size,
            top: ((small ? 20.9 : 19.3) / 100) * size - ((small ? 9 : 7.5) / 100) * size,
            width: ((small ? 18 : 15) / 100) * size,
            height: ((small ? 18 : 15) / 100) * size,
            borderRadius: size,
            backgroundColor: tone,
          },
          dotStyle,
        ]}
      />
    </View>
  );
}

/** "DeepW◯rk": the o of Work is the mark. */
export function Wordmark({ size = 20, color, markColor }: { size?: number; color?: string; markColor?: string }) {
  const { c } = useTheme();
  const tone = color ?? c.text;
  const o = size * 0.56;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }} accessible accessibilityRole="header" accessibilityLabel="DeepWork">
      <T style={{ fontFamily: fonts.displayBold, fontSize: size, lineHeight: size * 1.25, letterSpacing: -0.02 * size, color: tone }}>
        DeepW
      </T>
      <View style={{ width: o, height: o, marginHorizontal: size * 0.02, transform: [{ translateY: size * 0.02 }] }}>
        <DeepWorkMark size={o} color={markColor ?? c.mark} />
      </View>
      <T style={{ fontFamily: fonts.displayBold, fontSize: size, lineHeight: size * 1.25, letterSpacing: -0.02 * size, color: tone }}>
        rk
      </T>
    </View>
  );
}

/** Small mark + "DeepWork" used in headers. */
export function BrandRow({ size = 18 }: { size?: number }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <DeepWorkMark size={size + 4} color={c.mark} />
      <T style={{ fontFamily: fonts.displayBold, fontSize: size, lineHeight: size * 1.3, color: c.text }}>DeepWork</T>
    </View>
  );
}
