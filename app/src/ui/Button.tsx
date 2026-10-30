import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, type StyleProp, View, type ViewStyle } from 'react-native';
import { radius, size, useTheme } from '@/lib/theme';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'ink' | 'dark' | 'danger' | 'link';

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  iconRight,
  disabled,
  loading,
  compact,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  icon?: IconName;
  iconRight?: IconName;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const { c, scheme } = useTheme();
  const look: Record<Variant, { bg: string; fg: string; border?: string }> = {
    primary: { bg: c.button, fg: c.onButton },
    secondary: { bg: c.sand, fg: c.text },
    ghost: { bg: 'transparent', fg: c.text },
    outline: { bg: 'transparent', fg: c.text, border: c.lineStrong },
    ink: { bg: scheme === 'light' ? c.inverseSurface : c.surface, fg: '#FAF9F5', border: scheme === 'dark' ? c.lineStrong : undefined },
    dark: { bg: '#30302E', fg: '#FAF9F5' },
    danger: { bg: 'transparent', fg: c.danger, border: c.danger },
    link: { bg: 'transparent', fg: c.button },
  };
  const l = disabled && variant === 'primary' ? { bg: c.sand, fg: c.textMuted } : look[variant];
  const height = compact ? 44 : size.button;
  return (
    <Pressable
      onPress={() => {
        if (disabled || loading) return;
        Haptics.selectionAsync().catch(() => undefined);
        onPress?.();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      style={({ pressed }) => [
        {
          minHeight: variant === 'link' ? 44 : height,
          borderRadius: radius.button,
          backgroundColor: l.bg,
          borderWidth: l.border ? 1 : 0,
          borderColor: l.border,
          paddingHorizontal: variant === 'link' ? 4 : compact ? 16 : 20,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.85 : disabled && variant !== 'primary' ? 0.5 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={l.fg} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {icon ? <Icon name={icon} size={18} color={l.fg} /> : null}
          <T variant="label" color={l.fg} style={{ fontSize: compact ? 15 : 16 }}>
            {label}
          </T>
          {iconRight ? <Icon name={iconRight} size={18} color={l.fg} /> : null}
        </View>
      )}
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  tone = 'sand',
  size: s = 44,
  iconSize = 20,
  style,
}: {
  icon: IconName;
  onPress?: () => void;
  label: string;
  tone?: 'sand' | 'ink' | 'kiln' | 'clear' | 'ivory' | 'dark';
  size?: number;
  iconSize?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { c, scheme } = useTheme();
  const tones = {
    sand: { bg: c.sand, fg: c.text },
    ink: { bg: scheme === 'light' ? c.inverseSurface : c.inverseSurface, fg: scheme === 'light' ? '#FAF9F5' : '#141413' },
    kiln: { bg: c.button, fg: c.onButton },
    clear: { bg: 'transparent', fg: c.text },
    ivory: { bg: '#FAF9F5', fg: '#141413' },
    dark: { bg: '#30302E', fg: '#FAF9F5' },
  }[tone];
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync().catch(() => undefined);
        onPress?.();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        {
          width: s,
          height: s,
          borderRadius: s / 2,
          backgroundColor: tones.bg,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} size={iconSize} color={tones.fg} />
    </Pressable>
  );
}
