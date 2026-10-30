// One transient message at a time ("Snoozed 10 minutes", errors from background work).

import { useSyncExternalStore } from 'react';

export interface BannerMessage {
  id: number;
  text: string;
  tone: 'ink' | 'danger';
}

let current: BannerMessage | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function showBanner(text: string, tone: 'ink' | 'danger' = 'ink', ms = 3200) {
  current = { id: ++seq, text, tone };
  listeners.forEach((l) => l());
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    listeners.forEach((l) => l());
  }, ms);
}

export function useBanner(): BannerMessage | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
