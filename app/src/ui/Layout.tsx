// Screen scaffolding: safe-area screens, top bars, avatar, loading and error states.

import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, type StyleProp, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, screenPadding, useTheme } from '@/lib/theme';
import { Button, IconButton } from './Button';
import { Icon } from './Icon';
import { T } from './Text';

export function Screen({
  children,
  scroll = true,
  padded = true,
  bottomInset = 24,
  style,
  background,
  footer,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  bottomInset?: number;
  style?: StyleProp<ViewStyle>;
  background?: string;
  footer?: ReactNode;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const inner: ViewStyle = {
    paddingTop: insets.top + 12,
    paddingHorizontal: padded ? screenPadding : 0,
    paddingBottom: (footer ? 16 : insets.bottom) + bottomInset,
    gap: 16,
  };
  return (
    <View style={{ flex: 1, backgroundColor: background ?? c.bg }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[inner, style]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, inner, style]}>{children}</View>
      )}
      {footer ? (
        <View style={{ paddingHorizontal: screenPadding, paddingTop: 8, paddingBottom: insets.bottom + 16, gap: 8 }}>
          {footer}
        </View>
      ) : null}
    </View>
  );
}

/** Back (or close) button, an optional centred title and a right slot. */
export function TopBar({
  title,
  right,
  close,
  onBack,
}: {
  title?: string;
  right?: ReactNode;
  close?: boolean;
  onBack?: () => void;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 12 }}>
      <IconButton
        icon={close ? 'x' : 'chevronLeft'}
        label={close ? 'Close' : 'Back'}
        onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/today')))}
      />
      <View style={{ flex: 1 }}>
        {title ? (
          <T variant="label" style={{ fontSize: 16, fontFamily: fonts.uiBold }}>
            {title}
          </T>
        ) : null}
      </View>
      {right}
    </View>
  );
}

export function Avatar({ name, size = 44, onPress }: { name: string; size?: number; onPress?: () => void }) {
  const { c, scheme } = useTheme();
  const initial = (name.trim()[0] ?? '·').toUpperCase();
  const bg = scheme === 'light' ? c.inverseSurface : c.inverseSurface;
  const fg = scheme === 'light' ? '#FAF9F5' : '#141413';
  const body = (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <T style={{ fontFamily: fonts.display, fontSize: size * 0.4, lineHeight: size * 0.5, color: fg }}>{initial}</T>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Settings" hitSlop={6}>
      {body}
    </Pressable>
  );
}

export function Loading({ label }: { label?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: c.bg }}>
      <ActivityIndicator color={c.mark} />
      {label ? <T tone="secondary">{label}</T> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32, backgroundColor: c.bg }}>
      <Icon name="alert" size={28} color={c.textSecondary} />
      <T align="center" tone="secondary">
        {message}
      </T>
      {onRetry ? <Button label="Try again" variant="secondary" onPress={onRetry} compact /> : null}
    </View>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
      <T variant="h2">{children}</T>
      {right}
    </View>
  );
}

export function Eyebrow({ children, tone = 'secondary' }: { children: ReactNode; tone?: 'secondary' | 'mark' }) {
  return (
    <T variant="eyebrow" tone={tone}>
      {children}
    </T>
  );
}
