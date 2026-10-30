import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { type TypeVariant, type, useTheme } from '@/lib/theme';

export type Tone = 'text' | 'secondary' | 'muted' | 'mark' | 'button' | 'onButton' | 'danger' | 'success' | 'inverse' | 'accentOnInverse';

interface Props extends TextProps {
  variant?: TypeVariant;
  tone?: Tone;
  color?: string;
  align?: TextStyle['textAlign'];
  weight?: 'regular' | 'medium' | 'bold';
}

export function T({ variant = 'body', tone = 'text', color, align, weight, style, ...rest }: Props) {
  const { c, scheme } = useTheme();
  const tones: Record<Tone, string> = {
    text: c.text,
    secondary: c.textSecondary,
    muted: c.textMuted,
    mark: c.mark,
    button: c.button,
    onButton: c.onButton,
    danger: c.danger,
    success: c.success,
    inverse: scheme === 'light' ? '#FAF9F5' : '#141413',
    accentOnInverse: c.accentOnInverse,
  };
  const base = type[variant] as TextStyle;
  const family =
    weight && (base.fontFamily?.startsWith('Inter') ?? false)
      ? { regular: 'Inter_400Regular', medium: 'Inter_500Medium', bold: 'Inter_600SemiBold' }[weight]
      : base.fontFamily;
  return (
    <RNText
      allowFontScaling
      maxFontSizeMultiplier={1.6}
      style={[base, { color: color ?? tones[tone], fontFamily: family }, align ? { textAlign: align } : null, style]}
      {...rest}
    />
  );
}
