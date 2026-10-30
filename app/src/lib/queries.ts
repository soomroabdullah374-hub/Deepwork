// React Query: one cached app state that every screen reads, refreshed after each change.

import { focusManager, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppState as RNAppState } from 'react-native';
import { api } from './api';
import { ApiError } from './http';
import type { AppState } from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60_000,
      retry: (count, err) => !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

// Refetch when the app comes back to the foreground.
RNAppState.addEventListener('change', (s) => focusManager.setFocused(s === 'active'));

export const STATE_KEY = ['state'] as const;

export function useAppState(enabled = true) {
  return useQuery({ queryKey: STATE_KEY, queryFn: () => api.state(), refetchInterval: 5 * 60_000, enabled });
}

let lastState: AppState | null = null;

/**
 * The state once loaded. Screens live below the loading gate in (app)/_layout, and the
 * last good copy covers the moment the cache is cleared after "Delete all my data".
 */
export function useLoadedState(): AppState {
  const { data } = useAppState();
  if (data) lastState = data;
  if (!lastState) throw new Error('state not loaded');
  return lastState;
}

/** A mutation that refreshes the app state when it succeeds. */
export function useChange<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: STATE_KEY }),
  });
}

/** Re-render every minute (the "now" line, countdowns). */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
