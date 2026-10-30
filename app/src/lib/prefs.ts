// Small on-device preferences: theme (so the first frame uses it) and one-time flags.

import { getItem, setItem } from './storage';
import { useSyncExternalStore } from 'react';
import type { ThemePreference } from './theme';

const THEME_KEY = 'deepwork.theme';
let theme: ThemePreference = 'auto';
const listeners = new Set<() => void>();

export async function loadPrefs() {
  const saved = await getItem(THEME_KEY).catch(() => null);
  if (saved === 'light' || saved === 'dark' || saved === 'auto') setTheme(saved, false);
}

export function setTheme(next: ThemePreference, persist = true) {
  if (next === theme) return;
  theme = next;
  listeners.forEach((l) => l());
  if (persist) setItem(THEME_KEY, next).catch(() => undefined);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => theme,
  );
}

export async function getFlag(name: string): Promise<boolean> {
  return (await getItem(`deepwork.flag.${name}`).catch(() => null)) === '1';
}

export async function setFlag(name: string) {
  await setItem(`deepwork.flag.${name}`, '1').catch(() => undefined);
}
