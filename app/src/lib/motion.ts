// Motion tokens with Reanimated. Every animation honours "Reduce motion".

import { useEffect } from 'react';
import {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

export const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);

/** Rise + fade in: 10 pt, 320 ms, staggered 70 ms by index. */
export function useRise(index = 0, distance = 10) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return;
    p.value = withDelay(index * 70, withTiming(1, { duration: 320, easing: EASE, reduceMotion: ReduceMotion.System }));
  }, [index, p, reduced]);
  return useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ translateY: (1 - p.value) * distance }],
  }));
}

/** 0 → 1 over `duration` (ring draw, progress fill). */
export function useDraw(duration = 900, delay = 0) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) return;
    p.value = 0;
    p.value = withDelay(delay, withTiming(1, { duration, easing: EASE }));
  }, [delay, duration, p, reduced]);
  return p;
}

/** A soft loop between 0 and 1 (pulsing dots, breathing halo). */
export function usePulse(duration = 1800) {
  const reduced = useReducedMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    p.value = withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [duration, p, reduced]);
  return p;
}

/** Clash shake: 3 pt left and right, twice. Call `shake()` to play. */
export function useShake() {
  const reduced = useReducedMotion();
  const x = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const shake = () => {
    if (reduced) return;
    const step = (to: number) => withTiming(to, { duration: 65 });
    x.value = withSequence(step(-3), step(3), step(-3), step(3), step(0));
  };
  return { style, shake };
}
