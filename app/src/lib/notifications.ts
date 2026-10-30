// Local notifications: reminders are scheduled on the phone from the synced schedule,
// so they work without any push service. Actions: Start, Snooze 10m, Done.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { planReminders, type Reminder, remindersSignature } from './reminders';
import type { AppState } from './types';

export const CHANNEL_ID = 'sessions';
export const CATEGORY_ID = 'session';

let ready = false;
let lastSignature = '';

export async function setupNotifications() {
  if (ready) return;
  ready = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Sessions',
      description: 'Reminders before and at the start of your focus sessions',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 120, 180],
      lightColor: '#B8532F',
    }).catch(() => undefined);
  }
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    { identifier: 'start', buttonTitle: 'Start', options: { opensAppToForeground: true } },
    { identifier: 'snooze', buttonTitle: 'Snooze 10m', options: { opensAppToForeground: true } },
    { identifier: 'done', buttonTitle: 'Done', options: { opensAppToForeground: true } },
  ]).catch(() => undefined);
}

export async function hasPermission(): Promise<boolean> {
  const p = await Notifications.getPermissionsAsync();
  return p.granted;
}

export async function askPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

async function schedule(r: Reminder) {
  const withActions = r.kind === 'lead' || r.kind === 'start';
  await Notifications.scheduleNotificationAsync({
    identifier: r.id,
    content: {
      title: r.title,
      body: r.body,
      data: { url: r.url, kind: r.kind, block_id: r.blockId ?? null, goal_id: r.goalId ?? null },
      categoryIdentifier: withActions ? CATEGORY_ID : undefined,
      sound: 'default',
      color: '#B8532F',
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: r.at, channelId: CHANNEL_ID },
  });
}

/** Replace the scheduled reminders with the ones the current state calls for. */
export async function syncReminders(state: AppState, now = new Date()): Promise<number> {
  if (!(await hasPermission())) return 0;
  const plan = planReminders(state, now);
  const signature = remindersSignature(plan);
  if (signature === lastSignature) return plan.length;
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const r of plan) await schedule(r).catch(() => undefined);
  lastSignature = signature;
  return plan.length;
}

export async function clearReminders() {
  lastSignature = '';
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => undefined);
  await Notifications.dismissAllNotificationsAsync().catch(() => undefined);
}
