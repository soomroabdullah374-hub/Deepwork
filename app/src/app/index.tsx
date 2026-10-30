// [11] Launch: Kiln background, the mark draws in, then the wordmark rises.
// Holds until this phone's account is checked (at least 1.2 s), then routes on.

import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { startAccount, useAuth } from '@/lib/auth';
import { useRise } from '@/lib/motion';
import { getFlag } from '@/lib/prefs';
import { fonts } from '@/lib/theme';
import { DeepWorkMark, T, Wordmark } from '@/ui';

const IVORY = '#FAF9F5';

function Rise({ delay, children }: { delay: number; children: React.ReactNode }) {
  const style = useRise(delay / 70);
  return <Animated.View style={style}>{children}</Animated.View>;
}

export default function Launch() {
  const auth = useAuth();
  const reduced = useReducedMotion();
  const [minTimeDone, setMinTimeDone] = useState(false);
  const [showWords, setShowWords] = useState(false);
  const routed = useRef(false);
  const bar = useSharedValue(0);

  useEffect(() => {
    const t1 = setTimeout(() => setShowWords(true), reduced ? 0 : 700);
    const t2 = setTimeout(() => setMinTimeDone(true), 1200);
    if (!reduced) bar.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }), -1, false);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [bar, reduced]);

  useEffect(() => {
    if (!minTimeDone || auth.status === 'loading' || routed.current) return;
    routed.current = true;
    (async () => {
      if (auth.status === 'signed_in') return router.replace('/today');
      if (!(await getFlag('onboarded'))) return router.replace('/onboarding');
      // Seen the intro before, but there is no account on this phone (everything was
      // deleted): start a fresh one. If that fails, the intro's button tries again.
      try {
        await startAccount();
        router.replace('/today');
      } catch {
        router.replace('/onboarding');
      }
    })();
  }, [auth.status, minTimeDone]);

  const barStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -44 + bar.value * 88 }] }));

  return (
    <View style={{ flex: 1, backgroundColor: '#B8532F', alignItems: 'center', justifyContent: 'center' }}>
      <DeepWorkMark size={132} color={IVORY} animated />
      <View style={{ height: 120, alignItems: 'center', marginTop: 28 }}>
        {showWords ? (
          <>
            <Rise delay={0}>
              <Wordmark size={40} color={IVORY} markColor={IVORY} />
            </Rise>
            <Rise delay={140}>
              <T variant="body" color={IVORY} style={{ marginTop: 6, fontFamily: fonts.uiMedium }}>
                Show up. Go deep.
              </T>
            </Rise>
          </>
        ) : null}
      </View>
      <View style={{ position: 'absolute', bottom: 64, width: 88, height: 3, borderRadius: 2, backgroundColor: 'rgba(250,249,245,0.25)', overflow: 'hidden' }}>
        <Animated.View style={[{ width: 44, height: 3, borderRadius: 2, backgroundColor: IVORY }, barStyle]} />
      </View>
    </View>
  );
}
