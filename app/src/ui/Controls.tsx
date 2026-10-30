// Chips, day pills, segmented control, switch, text fields.

import * as Haptics from 'expo-haptics';
import { type ReactNode, type Ref, useEffect, useState } from 'react';
import {
  Pressable,
  type StyleProp,
  TextInput,
  type TextInputInstance,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { EASE } from '@/lib/motion';
import { fonts, radius, useTheme } from '@/lib/theme';
import { MONDAY_FIRST, WEEKDAY_LETTERS, WEEKDAYS_LONG } from '@/lib/time';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

const tap = () => Haptics.selectionAsync().catch(() => undefined);

export function Chip({
  label,
  selected,
  onPress,
  tone = 'sand',
  mono,
  icon,
  style,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  tone?: 'sand' | 'ink' | 'kiln' | 'outline';
  mono?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  const { c, scheme } = useTheme();
  const ink = scheme === 'light' ? c.inverseSurface : c.inverseSurface;
  const inkText = scheme === 'light' ? '#FAF9F5' : '#141413';
  const on = selected
    ? tone === 'kiln'
      ? { bg: c.button, fg: c.onButton, border: c.button }
      : { bg: ink, fg: inkText, border: ink }
    : tone === 'ink'
      ? { bg: ink, fg: inkText, border: ink }
      : tone === 'outline'
        ? { bg: 'transparent', fg: c.text, border: c.lineStrong }
        : { bg: c.sand, fg: c.text, border: c.sand };
  const content = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {icon ? <Icon name={icon} size={14} color={on.fg} /> : null}
      <T
        variant={mono ? 'time' : 'label'}
        color={on.fg}
        style={mono ? { fontSize: 14 } : { fontFamily: fonts.uiMedium, fontSize: 14 }}
      >
        {label}
      </T>
    </View>
  );
  const box: ViewStyle = {
    minHeight: onPress ? 44 : 28,
    paddingHorizontal: onPress ? 14 : 10,
    borderRadius: radius.chip,
    backgroundColor: on.bg,
    borderWidth: 1,
    borderColor: on.border,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: disabled ? 0.45 : 1,
  };
  if (!onPress) return <View style={[box, style]}>{content}</View>;
  return (
    <Pressable
      onPress={() => {
        if (disabled) return;
        tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [box, { opacity: pressed ? 0.8 : box.opacity }, style]}
    >
      {content}
    </Pressable>
  );
}

/** Seven 44 pt day pills, Monday first. */
export function DayPills({
  value,
  onChange,
  tone = 'kiln',
  single,
}: {
  value: number[];
  onChange: (days: number[]) => void;
  tone?: 'kiln' | 'ink';
  single?: boolean;
}) {
  const { c, scheme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }} accessibilityRole="radiogroup">
      {MONDAY_FIRST.map((d) => {
        const on = value.includes(d);
        const bg = on ? (tone === 'kiln' ? c.button : scheme === 'light' ? c.inverseSurface : c.inverseSurface) : c.sand;
        const fg = on ? (tone === 'kiln' ? c.onButton : scheme === 'light' ? '#FAF9F5' : '#141413') : c.text;
        return (
          <Pressable
            key={d}
            onPress={() => {
              tap();
              if (single) onChange([d]);
              else onChange(on ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b));
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={WEEKDAYS_LONG[d]}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}
          >
            <T variant="label" color={fg} style={{ fontFamily: fonts.uiMedium }}>
              {WEEKDAY_LETTERS[d]}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  compact,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  compact?: boolean;
}) {
  const { c, scheme } = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: 'row', backgroundColor: c.sand, borderRadius: compact ? 12 : 16, padding: 4, gap: 4 }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              tap();
              onChange(o.value);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            style={{
              flex: compact ? undefined : 1,
              minHeight: compact ? 36 : 40,
              paddingHorizontal: compact ? 12 : 8,
              borderRadius: compact ? 9 : 12,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? (scheme === 'light' ? c.surface : c.bg) : 'transparent',
            }}
          >
            <T variant="label" tone={on ? 'text' : 'secondary'} style={{ fontFamily: on ? fonts.uiBold : fonts.uiMedium }}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  const { c } = useTheme();
  const x = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    x.value = withTiming(value ? 1 : 0, { duration: 180, easing: EASE });
  }, [value, x]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * 20 }] }));
  const track = useAnimatedStyle(() => ({ backgroundColor: x.value > 0.5 ? c.button : c.lineStrong }));
  return (
    <Pressable
      onPress={() => {
        tap();
        onChange(!value);
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      hitSlop={8}
    >
      <Animated.View style={[{ width: 48, height: 28, borderRadius: 14, padding: 3 }, track]}>
        <Animated.View style={[{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#FAF9F5' }, knob]} />
      </Animated.View>
    </Pressable>
  );
}

interface FieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  error?: string | null;
  icon?: IconName;
  right?: ReactNode;
  counter?: string;
  multiline?: boolean;
  ref?: Ref<TextInputInstance>;
}

export function Field({ label, hint, error, icon, right, counter, multiline, style, onFocus, onBlur, ref, ...rest }: FieldProps) {
  const { c } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <T variant="label" style={{ fontFamily: fonts.uiBold }}>
          {label}
        </T>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          minHeight: multiline ? 96 : 52,
          borderRadius: radius.input,
          borderWidth: focused ? 2 : 1,
          borderColor: error ? c.danger : focused ? c.focusRing : c.line,
          backgroundColor: c.surface,
          paddingHorizontal: focused ? 15 : 16,
          paddingVertical: multiline ? 12 : 0,
          gap: 10,
        }}
      >
        {icon ? <Icon name={icon} size={18} color={c.textSecondary} /> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={c.textMuted}
          multiline={multiline}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[
            {
              flex: 1,
              color: c.text,
              fontFamily: fonts.ui,
              fontSize: 16,
              lineHeight: 22,
              paddingVertical: multiline ? 0 : 12,
              textAlignVertical: multiline ? 'top' : 'center',
              minHeight: multiline ? 72 : undefined,
            },
            style,
          ]}
          {...rest}
        />
        {right}
      </View>
      {(hint || counter || error) && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <T variant="caption" tone={error ? 'danger' : 'secondary'} style={{ flex: 1 }}>
            {error ?? hint ?? ''}
          </T>
          {counter ? (
            <T variant="caption" tone="secondary" style={{ fontFamily: fonts.mono }}>
              {counter}
            </T>
          ) : null}
        </View>
      )}
    </View>
  );
}
