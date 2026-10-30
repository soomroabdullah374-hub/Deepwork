// Bottom sheet (scrim + slide up) and the undo toast with a draining bar.

import { type ReactNode, useEffect } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EASE } from '@/lib/motion';
import { radius, screenPadding, useTheme } from '@/lib/theme';
import { T } from './Text';

export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const y = useSharedValue(1);
  useEffect(() => {
    y.value = withTiming(visible ? 0 : 1, { duration: reduced ? 0 : 320, easing: EASE });
  }, [reduced, visible, y]);
  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value * 600 }] }));
  const scrim = useAnimatedStyle(() => ({ opacity: 1 - y.value }));
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[{ position: 'absolute', inset: 0, backgroundColor: c.scrim }, scrim]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
        </Animated.View>
        <View style={{ flex: 1 }} pointerEvents="box-none" />
        <Animated.View
          style={[
            {
              backgroundColor: c.surface,
              borderTopLeftRadius: radius.sheet,
              borderTopRightRadius: radius.sheet,
              paddingHorizontal: screenPadding,
              paddingTop: 10,
              paddingBottom: insets.bottom + 16,
              gap: 14,
            },
            sheet,
          ]}
        >
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.lineStrong }} />
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Ink toast: message, an action, and a bar that drains over `duration` ms. */
export function UndoToast({
  message,
  actionLabel = 'Undo',
  onAction,
  duration = 10_000,
  onDone,
}: {
  message: string;
  actionLabel?: string;
  onAction: () => void;
  duration?: number;
  onDone: () => void;
}) {
  const { c, scheme } = useTheme();
  const reduced = useReducedMotion();
  const drain = useSharedValue(1);
  useEffect(() => {
    drain.value = withTiming(0, { duration, easing: Easing.linear }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const bar = useAnimatedStyle(() => ({ transform: [{ scaleX: drain.value }] }));
  const bg = scheme === 'light' ? c.inverseSurface : '#30302E';
  return (
    <View style={{ borderRadius: 16, backgroundColor: bg, overflow: 'hidden' }} accessibilityLiveRegion="polite">
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 8, minHeight: 52 }}>
        <T variant="bodySm" color="#FAF9F5" style={{ flex: 1 }}>
          {message}
        </T>
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={{ backgroundColor: '#30302E', borderRadius: 10, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' }}
        >
          <T variant="label" color="#FAF9F5">
            {actionLabel}
          </T>
        </Pressable>
      </View>
      {reduced ? null : (
        <Animated.View style={[{ height: 3, backgroundColor: c.mark, transformOrigin: 'left' }, bar]} />
      )}
    </View>
  );
}

/** A short message that floats above the tab bar and fades after a few seconds. */
export function Banner({ message, tone = 'ink' }: { message: string; tone?: 'ink' | 'danger' }) {
  const { c, scheme } = useTheme();
  const bg = tone === 'danger' ? c.danger : scheme === 'light' ? c.inverseSurface : '#30302E';
  return (
    <View style={{ borderRadius: 14, backgroundColor: bg, paddingHorizontal: 16, paddingVertical: 12 }} accessibilityLiveRegion="polite">
      <T variant="bodySm" color="#FAF9F5">
        {message}
      </T>
    </View>
  );
}
