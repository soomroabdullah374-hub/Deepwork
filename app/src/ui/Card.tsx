import type { ReactNode } from 'react';
import { Pressable, type StyleProp, View, type ViewStyle } from 'react-native';
import { radius, useTheme } from '@/lib/theme';

export function Card({
  children,
  style,
  onPress,
  padded = true,
  tone = 'surface',
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  padded?: boolean;
  tone?: 'surface' | 'sunk' | 'ink' | 'danger';
  accessibilityLabel?: string;
}) {
  const { c, scheme } = useTheme();
  const look = {
    surface: { backgroundColor: c.surface, borderColor: c.line },
    sunk: { backgroundColor: c.surfaceSunk, borderColor: c.line },
    ink: { backgroundColor: scheme === 'light' ? c.inverseSurface : c.surface, borderColor: scheme === 'light' ? c.inverseSurface : c.lineStrong },
    danger: { backgroundColor: c.surface, borderColor: c.danger },
  }[tone];
  const base: ViewStyle = {
    borderRadius: tone === 'ink' ? radius.heroCard : radius.card,
    borderWidth: 1,
    padding: padded ? 16 : 0,
    overflow: 'hidden',
    ...look,
  };
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [base, { opacity: pressed ? 0.9 : 1 }, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{children}</View>;
}

/** Colours for text on the ink hero card (ivory in both themes). */
export const onInk = { text: '#FAF9F5', secondary: '#B0AEA5', accent: '#D97757' };
