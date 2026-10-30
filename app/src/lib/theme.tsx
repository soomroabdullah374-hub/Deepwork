// Design tokens from 03_Specs/design-tokens.json, and the light/dark theme context.

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type TextStyle, useColorScheme } from 'react-native';

export const palette = {
  light: {
    bg: '#F5F4ED',
    surface: '#FAF9F5',
    surfaceSunk: '#F0EEE6',
    sand: '#E8E6DC',
    line: '#E8E6DC',
    lineStrong: '#D9D6CA',
    text: '#141413',
    textSecondary: '#5E5D59',
    textMuted: '#87867F',
    mark: '#C96442',
    button: '#B8532F',
    onButton: '#FAF9F5',
    inverseSurface: '#141413',
    inverseSurface2: '#30302E',
    accentOnInverse: '#D97757',
    success: '#788C5D',
    danger: '#B53333',
    focusRing: '#3898EC',
    scrim: 'rgba(20,20,19,0.45)',
  },
  dark: {
    bg: '#141413',
    surface: '#1F1E1D',
    surfaceSunk: '#1A1918',
    sand: '#30302E',
    line: '#30302E',
    lineStrong: '#4A4945',
    text: '#FAF9F5',
    textSecondary: '#B0AEA5',
    textMuted: '#87867F',
    mark: '#D97757',
    button: '#B8532F',
    onButton: '#FAF9F5',
    inverseSurface: '#FAF9F5',
    inverseSurface2: '#E8E6DC',
    accentOnInverse: '#B8532F',
    success: '#9AB07D',
    danger: '#E06B6B',
    focusRing: '#3898EC',
    scrim: 'rgba(0,0,0,0.6)',
  },
} as const;

export type Colors = { [K in keyof typeof palette.light]: string };
export type Scheme = 'light' | 'dark';
export type ThemePreference = 'light' | 'dark' | 'auto';

export const fonts = {
  display: 'SourceSerif4_500Medium',
  displayBold: 'SourceSerif4_600SemiBold',
  displayItalic: 'SourceSerif4_400Regular_Italic',
  ui: 'Inter_400Regular',
  uiMedium: 'Inter_500Medium',
  uiBold: 'Inter_600SemiBold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export const fontFiles = {
  SourceSerif4_500Medium: require('@expo-google-fonts/source-serif-4/500Medium/SourceSerif4_500Medium.ttf'),
  SourceSerif4_600SemiBold: require('@expo-google-fonts/source-serif-4/600SemiBold/SourceSerif4_600SemiBold.ttf'),
  SourceSerif4_400Regular_Italic: require('@expo-google-fonts/source-serif-4/400Regular_Italic/SourceSerif4_400Regular_Italic.ttf'),
  Inter_400Regular: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
  Inter_500Medium: require('@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
  Inter_600SemiBold: require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
  JetBrainsMono_400Regular: require('@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf'),
  JetBrainsMono_500Medium: require('@expo-google-fonts/jetbrains-mono/500Medium/JetBrainsMono_500Medium.ttf'),
};

export const type = {
  display: { fontFamily: fonts.display, fontSize: 34, lineHeight: 40, letterSpacing: -0.5 },
  h1: { fontFamily: fonts.display, fontSize: 32, lineHeight: 38, letterSpacing: -0.5 },
  h2: { fontFamily: fonts.display, fontSize: 22, lineHeight: 28 },
  cardTitle: { fontFamily: fonts.display, fontSize: 19, lineHeight: 24 },
  body: { fontFamily: fonts.ui, fontSize: 16, lineHeight: 24 },
  bodySm: { fontFamily: fonts.ui, fontSize: 15, lineHeight: 22 },
  label: { fontFamily: fonts.uiBold, fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18 },
  eyebrow: { fontFamily: fonts.uiBold, fontSize: 12, lineHeight: 16, letterSpacing: 1, textTransform: 'uppercase' },
  tab: { fontFamily: fonts.uiMedium, fontSize: 11, lineHeight: 14 },
  time: { fontFamily: fonts.monoMedium, fontSize: 14, lineHeight: 20 },
  timer: { fontFamily: fonts.mono, fontSize: 64, lineHeight: 72, letterSpacing: -2 },
} satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof type;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, huge: 48 } as const;
export const screenPadding = 20;
export const radius = { chip: 999, button: 16, input: 16, card: 20, heroCard: 24, sheet: 28, tabBar: 24 } as const;
export const size = { touchMin: 44, button: 54, iconButton: 44, tabBarHeight: 68, micButton: 60, dayChip: 44 } as const;
export const easing = [0.2, 0.8, 0.2, 1] as const;

interface ThemeValue {
  scheme: Scheme;
  c: Colors;
  /** Colours for the always-dark screens (Focus, Assistant listening). */
  dark: Colors;
}

const ThemeContext = createContext<ThemeValue>({ scheme: 'light', c: palette.light, dark: palette.dark });

export function ThemeProvider({ preference, children }: { preference: ThemePreference; children: ReactNode }) {
  const system = useColorScheme();
  const scheme: Scheme = preference === 'auto' ? (system === 'dark' ? 'dark' : 'light') : preference;
  const value = useMemo(() => ({ scheme, c: palette[scheme], dark: palette.dark }), [scheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

/** A forced-dark theme for Focus and the listening screen. */
export function DarkTheme({ children }: { children: ReactNode }) {
  const value = useMemo(() => ({ scheme: 'dark' as const, c: palette.dark, dark: palette.dark }), []);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
