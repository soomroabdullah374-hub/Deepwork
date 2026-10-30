// Everything behind sign-in. Loads the app state once, keeps reminders in sync with it
// and turns notification taps and actions into navigation or quick changes.

import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import { Redirect, router, Stack } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { showBanner } from '@/lib/banner';
import { ApiError, errorMessage } from '@/lib/http';
import { askPermission, syncReminders } from '@/lib/notifications';
import { getFlag, setFlag, setTheme } from '@/lib/prefs';
import { queryClient, STATE_KEY, useAppState } from '@/lib/queries';
import { useTheme } from '@/lib/theme';
import { ErrorState, Loading } from '@/ui';

function routeFor(url: string | undefined): string | null {
  if (!url) return null;
  const { hostname, path } = Linking.parse(url);
  const parts = [hostname, ...(path ?? '').split('/')].filter(Boolean) as string[];
  if (parts[0] === 'focus' && parts[1]) return `/focus/${parts[1]}`;
  if (parts[0] === 'move' && parts[1]) return `/move/${parts[1]}`;
  if (parts[0] === 'goal' && parts[1]) return `/goal/${parts[1]}`;
  return '/today';
}

// Notification responses only exist on the phone (the browser preview has none).
const useLastResponse: typeof Notifications.useLastNotificationResponse =
  Platform.OS === 'web' ? () => undefined : Notifications.useLastNotificationResponse;

function useNotificationResponses(enabled: boolean) {
  const response = useLastResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !response) return;
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}:${response.notification.date}`;
    if (handled.current === key) return;
    handled.current = key;
    const data = response.notification.request.content.data as { url?: string; block_id?: string | null };
    const id = data.block_id ?? undefined;
    (async () => {
      try {
        if (response.actionIdentifier === 'snooze' && id) {
          await api.blockAction(id, 'snooze', { minutes: 10 });
          await queryClient.invalidateQueries({ queryKey: STATE_KEY });
          showBanner('Snoozed for 10 minutes.');
          router.navigate('/today');
        } else if (response.actionIdentifier === 'done' && id) {
          await api.blockAction(id, 'finish', {});
          await queryClient.invalidateQueries({ queryKey: STATE_KEY });
          showBanner('Marked as done. Nice work.');
          router.navigate('/today');
        } else if (response.actionIdentifier === 'start' && id) {
          router.push(`/focus/${id}`);
        } else {
          const to = routeFor(data.url);
          if (to) router.push(to as never);
        }
      } catch (err) {
        showBanner(errorMessage(err), 'danger');
      }
      Notifications.clearLastNotificationResponseAsync?.().catch(() => undefined);
    })();
  }, [enabled, response]);
}

export default function AppLayout() {
  const auth = useAuth();
  const { c } = useTheme();
  const state = useAppState(auth.status === 'signed_in');
  const data = state.data;

  useNotificationResponses(Boolean(data));

  useEffect(() => {
    if (!data) return;
    setTheme(data.profile.theme);
    syncReminders(data).catch(() => undefined);
  }, [data]);

  // Ask for notification permission once, after the first goal exists.
  useEffect(() => {
    if (!data || data.goals.length === 0 || !data.profile.notifications_enabled) return;
    (async () => {
      if (await getFlag('asked-notifications')) return;
      await setFlag('asked-notifications');
      if (await askPermission()) syncReminders(data).catch(() => undefined);
    })();
  }, [data]);

  if (auth.status === 'signed_out') return <Redirect href="/sign-in" />;
  if (auth.status === 'loading') return <Loading />;
  if (!data) {
    if (state.error) {
      const signedOut = state.error instanceof ApiError && state.error.status === 401;
      if (signedOut) return <Redirect href="/sign-in" />;
      return <ErrorState message={errorMessage(state.error)} onRetry={() => state.refetch()} />;
    }
    return <Loading />;
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }}>
      <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
      <Stack.Screen name="new-goal" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="focus/[id]" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="assistant" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="move/[id]" options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }} />
      <Stack.Screen name="commitment" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
    </Stack>
  );
}
