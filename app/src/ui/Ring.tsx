// Progress ring that draws in, and a thin progress bar that fills.

import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedProps, useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useDraw } from '@/lib/motion';
import { useTheme } from '@/lib/theme';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function ProgressRing({
  size = 56,
  stroke = 6,
  progress,
  color,
  track,
  children,
  duration = 900,
  accessibilityLabel,
}: {
  size?: number;
  stroke?: number;
  progress: number;
  color?: string;
  track?: string;
  children?: ReactNode;
  duration?: number;
  accessibilityLabel?: string;
}) {
  const { c } = useTheme();
  const p = useDraw(duration);
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const value = Math.max(0, Math.min(1, progress));
  const props = useAnimatedProps(() => ({ strokeDashoffset: circ * (1 - value * p.value) }));
  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
    >
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track ?? c.sand} strokeWidth={stroke} fill="none" />
        {value > 0 ? (
          <AnimatedCircle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color ?? c.mark}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${circ} ${circ}`}
            animatedProps={props}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>
      {children}
    </View>
  );
}

export function ProgressBar({ progress, color, height = 6 }: { progress: number; color?: string; height?: number }) {
  const { c } = useTheme();
  const p = useDraw(500);
  const value = Math.max(0, Math.min(1, progress));
  const fill = useAnimatedStyle(() => ({ width: `${value * p.value * 100}%` }));
  return (
    <View style={{ height, borderRadius: height, backgroundColor: c.sand, overflow: 'hidden' }}>
      <Animated.View style={[{ height, borderRadius: height, backgroundColor: color ?? c.mark }, fill]} />
    </View>
  );
}
