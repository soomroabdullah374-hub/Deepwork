// [15] Settings: profile, planning, reminders and look, your data.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { type ReactNode, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TimeTile } from '@/features/pickers';
import { api } from '@/lib/api';
import { forgetAccount } from '@/lib/auth';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { overlapCount } from '@/lib/model';
import { askPermission, clearReminders, hasPermission, syncReminders } from '@/lib/notifications';
import { setTheme } from '@/lib/prefs';
import { STATE_KEY, useLoadedState } from '@/lib/queries';
import { fonts, screenPadding, type ThemePreference, useTheme } from '@/lib/theme';
import { deviceTimeZone, hhmm, zoneLabel } from '@/lib/time';
import type { AppState, Profile } from '@/lib/types';
import { Avatar, Button, Card, Field, Icon, type IconName, IconButton, Segmented, Sheet, Switch, T, TAB_BAR_SPACE } from '@/ui';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <T variant="eyebrow" tone="secondary" style={{ marginLeft: 4 }}>
        {title}
      </T>
      <Card padded={false}>{children}</Card>
    </View>
  );
}

function Row({
  label,
  caption,
  value,
  icon,
  onPress,
  right,
  first,
  danger,
}: {
  label: string;
  caption?: string;
  value?: string;
  icon?: IconName;
  onPress?: () => void;
  right?: ReactNode;
  first?: boolean;
  danger?: boolean;
}) {
  const { c } = useTheme();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: first ? 0 : 1, borderColor: c.line }}>
      {icon ? <Icon name={icon} size={20} color={danger ? c.danger : c.mark} /> : null}
      <View style={{ flex: 1 }}>
        <T variant="body" tone={danger ? 'danger' : 'text'} style={{ fontFamily: fonts.uiMedium }}>
          {label}
        </T>
        {caption ? (
          <T variant="caption" tone="secondary">
            {caption}
          </T>
        ) : null}
      </View>
      {value ? (
        <T variant="bodySm" tone="secondary" style={{ fontFamily: /\d/.test(value) ? fonts.mono : fonts.ui }}>
          {value}
        </T>
      ) : null}
      {right}
      {onPress && !right ? <Icon name="chevronRight" size={18} color={c.textSecondary} /> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}>
      {body}
    </Pressable>
  );
}

export default function Settings() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const state = useLoadedState();
  const qc = useQueryClient();
  const p = state.profile;
  const [sheet, setSheet] = useState<null | 'profile' | 'quiet' | 'briefing' | 'delete'>(null);
  const [name, setName] = useState(p.display_name);
  const [quiet, setQuiet] = useState({ start: hhmm(p.quiet_start), end: hhmm(p.quiet_end) });
  const [briefing, setBriefing] = useState(p.briefing_at ? hhmm(p.briefing_at) : '07:30');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 10 * 60_000 });
  const permission = useQuery({ queryKey: ['notif-permission'], queryFn: hasPermission });
  const clashes = overlapCount(state.blocks) + state.conflicts.length;
  const deviceTz = deviceTimeZone();

  const save = async (patch: Partial<Profile> & { onboarded?: boolean }, message?: string) => {
    const previous = qc.getQueryData<AppState>(STATE_KEY);
    if (previous) qc.setQueryData<AppState>(STATE_KEY, { ...previous, profile: { ...previous.profile, ...patch } as Profile });
    try {
      await api.updateProfile(patch);
      await qc.invalidateQueries({ queryKey: STATE_KEY });
      if (message) showBanner(message);
    } catch (err) {
      if (previous) qc.setQueryData(STATE_KEY, previous);
      showBanner(errorMessage(err), 'danger');
    }
  };

  const toggleNotifications = async (on: boolean) => {
    if (on) {
      const granted = await askPermission();
      if (!granted) {
        showBanner('Notifications are blocked for DeepWork. Allow them in system settings.', 'danger');
        Linking.openSettings().catch(() => undefined);
      }
      permission.refetch();
      await save({ notifications_enabled: true });
      const fresh = qc.getQueryData<AppState>(STATE_KEY);
      if (fresh) syncReminders(fresh).catch(() => undefined);
    } else {
      await save({ notifications_enabled: false });
      await clearReminders();
    }
  };

  const exportData = async () => {
    setBusy('export');
    try {
      const data = await api.exportData();
      const file = new File(Paths.cache, `deepwork-export-${new Date().toISOString().slice(0, 10)}.json`);
      if (file.exists) file.delete();
      file.create();
      await file.write(JSON.stringify(data, null, 2));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Your DeepWork data' });
      } else {
        showBanner('Export saved.');
      }
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    setBusy('delete');
    try {
      await api.deleteAccount();
      await forgetAccount();
      router.replace('/onboarding');
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
      setBusy(null);
    }
  };

  const version = Constants.expoConfig?.version ?? '1.0.0';
  const assistantReady = health.data?.llm.configured && health.data.speech_to_text.configured;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: screenPadding, paddingBottom: TAB_BAR_SPACE + insets.bottom + 16, gap: 18 }}>
        <T variant="h1">Settings</T>

        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Avatar name={p.display_name || 'You'} size={52} />
          <View style={{ flex: 1 }}>
            <T variant="label" style={{ fontSize: 17 }}>
              {p.display_name || 'Add your name'}
            </T>
            <T variant="caption" tone="secondary">{`${p.timezone} · ${zoneLabel(p.timezone)}`}</T>
          </View>
          <IconButton icon="pencil" label="Edit profile" onPress={() => setSheet('profile')} />
        </Card>

        <Group title="Planning">
          <Row first label="My schedule" icon="calendar" value={clashes ? `${clashes} clash${clashes === 1 ? '' : 'es'}` : 'No overlaps'} onPress={() => router.push('/schedule')} />
          <Row
            label="Assistant auto-apply"
            caption="Only when every check passes"
            icon="mic"
            right={<Switch label="Assistant auto-apply" value={p.assistant_auto_apply} onChange={(v) => save({ assistant_auto_apply: v })} />}
          />
          <Row
            label="Speak replies"
            caption="The assistant answers out loud"
            icon="speaker"
            right={<Switch label="Speak replies" value={p.speak_replies} onChange={(v) => save({ speak_replies: v })} />}
          />
        </Group>

        <Group title="Reminders and look">
          <Row
            first
            label="Notifications"
            caption={p.notifications_enabled && permission.data === false ? 'Blocked in system settings' : undefined}
            right={<Switch label="Notifications" value={p.notifications_enabled && permission.data !== false} onChange={toggleNotifications} />}
          />
          <Row label="Quiet hours" value={`${hhmm(p.quiet_start)}–${hhmm(p.quiet_end)}`} onPress={() => setSheet('quiet')} />
          <Row label="Morning briefing" value={p.briefing_at ? hhmm(p.briefing_at) : 'Off'} onPress={() => setSheet('briefing')} />
          <Row
            label="Hide titles in reminders"
            caption="Shows “Focus session” on the lock screen"
            right={<Switch label="Hide titles in reminders" value={p.hide_titles} onChange={(v) => save({ hide_titles: v })} />}
          />
          <Row
            label="Reminder language"
            right={
              <Segmented
                compact
                value={p.language}
                onChange={(language) => save({ language })}
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'ur-Latn', label: 'Roman Urdu' },
                ]}
              />
            }
          />
          <Row
            label="Theme"
            right={
              <Segmented<ThemePreference>
                compact
                value={p.theme}
                onChange={(theme) => {
                  setTheme(theme);
                  save({ theme });
                }}
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'auto', label: 'Auto' },
                ]}
              />
            }
          />
        </Group>

        <Group title="Your data">
          <Row
            first
            label="Export everything (JSON)"
            caption="Your plan lives with the app on this phone"
            icon="download"
            onPress={busy ? undefined : exportData}
            value={busy === 'export' ? 'Preparing…' : undefined}
          />
          <Row label="Privacy policy" icon="shield" onPress={() => router.push('/privacy')} />
          <Row label="Delete all my data" danger onPress={() => setSheet('delete')} />
        </Group>

        <T variant="caption" tone="secondary" align="center">
          {`DeepWork ${version} · Assistant ${health.isLoading ? 'checking…' : assistantReady ? `ready (${health.data?.llm.provider})` : 'not set up yet'}`}
        </T>
      </ScrollView>

      <Sheet visible={sheet === 'profile'} onClose={() => setSheet(null)}>
        <T variant="h2">Your profile</T>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Your name" autoFocus />
        {deviceTz !== p.timezone ? (
          <Button
            label={`Use this phone's time zone (${deviceTz})`}
            variant="secondary"
            onPress={() => {
              save({ timezone: deviceTz }, 'Time zone updated. Sessions keep their local times.');
              setSheet(null);
            }}
          />
        ) : (
          <T variant="caption" tone="secondary">{`Time zone: ${p.timezone}, same as this phone.`}</T>
        )}
        <Button
          label="Save"
          disabled={!name.trim()}
          onPress={() => {
            save({ display_name: name.trim() });
            setSheet(null);
          }}
        />
      </Sheet>

      <Sheet visible={sheet === 'quiet'} onClose={() => setSheet(null)}>
        <T variant="h2">Quiet hours</T>
        <T tone="secondary">No nudges in this window. The reminder at the very start of a session still comes through.</T>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TimeTile label="From" value={quiet.start} onChange={(start) => setQuiet({ ...quiet, start })} />
          <TimeTile label="Until" value={quiet.end} onChange={(end) => setQuiet({ ...quiet, end })} />
        </View>
        <Button
          label="Save"
          onPress={() => {
            save({ quiet_start: quiet.start, quiet_end: quiet.end });
            setSheet(null);
          }}
        />
      </Sheet>

      <Sheet visible={sheet === 'briefing'} onClose={() => setSheet(null)}>
        <T variant="h2">Morning briefing</T>
        <T tone="secondary">A short note on days with sessions: how many, and when the first one starts.</T>
        <TimeTile label="Time" value={briefing} onChange={setBriefing} />
        <Button
          label="Save"
          onPress={() => {
            save({ briefing_at: briefing });
            setSheet(null);
          }}
        />
        {p.briefing_at ? (
          <Button
            label="Turn off"
            variant="secondary"
            onPress={() => {
              save({ briefing_at: null });
              setSheet(null);
            }}
          />
        ) : null}
      </Sheet>

      <Sheet visible={sheet === 'delete'} onClose={() => setSheet(null)}>
        <T variant="h2">Delete all my data</T>
        <T tone="secondary">
          This removes your goals, sessions, commitments and assistant history from DeepWork, right away, and the app starts fresh. It can't be undone. Export first if you want a copy.
        </T>
        <Field label="Type DELETE to confirm" value={confirm} onChangeText={setConfirm} autoCapitalize="characters" />
        <Button label="Delete everything" variant="danger" disabled={confirm.trim() !== 'DELETE'} loading={busy === 'delete'} onPress={deleteAccount} />
      </Sheet>
    </View>
  );
}
