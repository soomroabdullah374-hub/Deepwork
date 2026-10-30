// Edit goal: title, why, start day and deadline, plan and rhythm; pause, resume, finish or delete.

import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import {
  DeadlineSummary,
  GoalDates,
  type MilestoneDraft,
  MilestoneEditor,
  newKey,
  type RhythmDraft,
  RhythmEditor,
  useRhythmCheck,
} from '@/features/goal-form';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { STATE_KEY, useLoadedState } from '@/lib/queries';
import { addDays, hhmm, localDate } from '@/lib/time';
import { Button, Card, Field, Screen, SectionTitle, Sheet, T, TopBar } from '@/ui';

export default function EditGoal() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLoadedState();
  const qc = useQueryClient();
  const goal = state.goals.find((g) => g.id === id);
  const tz = state.profile.timezone;
  const today = localDate(new Date(), tz);

  const [title, setTitle] = useState(goal?.title ?? '');
  const [why, setWhy] = useState(goal?.why ?? '');
  // a start that has passed shows as today; it only changes if a new day is picked
  const firstStart = goal?.start_date && goal.start_date > today ? goal.start_date : today;
  const [start, setStart] = useState(firstStart);
  const [deadline, setDeadline] = useState<string | null>(goal?.deadline ?? addDays(today, 30));
  const startDate = start > today ? start : null;
  const [milestones, setMilestones] = useState<MilestoneDraft[]>(
    (goal?.milestones ?? []).map((m) => ({ key: newKey(), id: m.id, title: m.title, done: Boolean(m.done_at) })),
  );
  const [rhythm, setRhythm] = useState<RhythmDraft>(
    goal?.rule
      ? { weekdays: goal.rule.weekdays, start_time: hhmm(goal.rule.start_time), duration_min: goal.rule.duration_min, lead_min: goal.rule.lead_min }
      : { weekdays: [1, 3, 5], start_time: '20:00', duration_min: 60, lead_min: 10 },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { result: check, checking } = useRhythmCheck(rhythm, goal?.id, { start: startDate, until: deadline });

  if (!goal) {
    return (
      <Screen>
        <TopBar />
        <T variant="h2">This goal is gone.</T>
      </Screen>
    );
  }

  const ruleChanged =
    !goal.rule ||
    goal.rule.weekdays.join(',') !== rhythm.weekdays.join(',') ||
    hhmm(goal.rule.start_time) !== rhythm.start_time ||
    goal.rule.duration_min !== rhythm.duration_min ||
    goal.rule.lead_min !== rhythm.lead_min;
  const clashes = ruleChanged ? (check?.clashes.length ?? 0) : 0;

  const run = async (label: string, fn: () => Promise<unknown>, done: string, leave = false) => {
    setBusy(label);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: STATE_KEY });
      showBanner(done);
      if (leave) router.back();
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const saveAll = () =>
    run(
      'save',
      async () => {
        const patch: { title?: string; why?: string | null; start_date?: string | null; deadline?: string } = {};
        if (title.trim() !== goal.title) patch.title = title.trim();
        if ((why.trim() || null) !== goal.why) patch.why = why.trim() || null;
        if (start !== firstStart) patch.start_date = startDate;
        if (deadline && deadline !== goal.deadline) patch.deadline = deadline;
        if (Object.keys(patch).length) await api.updateGoal(goal.id, patch);
        const before = goal.milestones.map((m) => `${m.id}:${m.title}`).join('|');
        const after = milestones.filter((m) => m.title.trim()).map((m) => `${m.id}:${m.title.trim()}`).join('|');
        if (before !== after) {
          await api.replaceMilestones(goal.id, milestones.filter((m) => m.title.trim()).map((m) => ({ id: m.id, title: m.title.trim(), done: m.done })));
        }
        if (ruleChanged) await api.updateRule(goal.id, rhythm);
      },
      'Goal saved.',
      true,
    );

  const setStatus = (status: 'active' | 'paused' | 'done', message: string) =>
    run(status, () => api.updateGoal(goal.id, { status }), message, true);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        footer={
          <Button
            label={clashes ? `Fix ${clashes} clash${clashes === 1 ? '' : 'es'} to save` : 'Save changes'}
            disabled={title.trim().length < 3 || !deadline || clashes > 0 || (ruleChanged && checking) || rhythm.weekdays.length === 0}
            loading={busy === 'save'}
            onPress={saveAll}
          />
        }
      >
        <TopBar title="Edit goal" close />
        <Field label="Goal" value={title} onChangeText={(t) => setTitle(t.slice(0, 80))} counter={`${title.length}/80`} />
        <Field label="Why it matters · optional" value={why} onChangeText={(t) => setWhy(t.slice(0, 500))} multiline />

        <SectionTitle>Start and deadline</SectionTitle>
        <GoalDates
          today={today}
          start={start}
          deadline={deadline}
          firstPick="end"
          onChange={(s, d) => {
            setStart(s);
            setDeadline(d);
          }}
        />
        {deadline ? <DeadlineSummary today={today} start={start} deadline={deadline} /> : null}

        <SectionTitle>Plan</SectionTitle>
        <MilestoneEditor items={milestones} onChange={setMilestones} />

        <SectionTitle>Rhythm</SectionTitle>
        <RhythmEditor
          state={state}
          rhythm={rhythm}
          onChange={setRhythm}
          startDate={startDate}
          deadline={deadline ?? goal.deadline}
          check={ruleChanged ? check : null}
          checking={ruleChanged && checking}
          excludeGoal={goal.id}
        />

        <SectionTitle>Status</SectionTitle>
        <Card style={{ gap: 10 }}>
          <T tone="secondary">
            {goal.status === 'active'
              ? 'Pausing clears upcoming sessions; resuming books them again.'
              : goal.status === 'paused'
                ? 'This goal is paused. Resume to book its sessions again.'
                : 'This goal is finished.'}
          </T>
          {goal.status !== 'active' ? (
            <Button label="Resume goal" variant="secondary" loading={busy === 'active'} onPress={() => setStatus('active', 'Goal resumed. Sessions are booked again.')} />
          ) : (
            <Button label="Pause goal" variant="secondary" loading={busy === 'paused'} onPress={() => setStatus('paused', 'Goal paused.')} />
          )}
          {goal.status !== 'done' ? (
            <Button label="Mark as finished" variant="secondary" loading={busy === 'done'} onPress={() => setStatus('done', 'Finished. Well done.')} />
          ) : null}
          <Button label="Delete goal" variant="danger" onPress={() => setConfirmDelete(true)} />
        </Card>
        <View style={{ height: 8 }} />
      </Screen>

      <Sheet visible={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <T variant="h2">Delete this goal?</T>
        <T tone="secondary">Its plan and all its sessions, past and future, are removed. This can't be undone.</T>
        <Button
          label="Delete goal"
          variant="danger"
          loading={busy === 'delete'}
          onPress={() =>
            run(
              'delete',
              async () => {
                await api.deleteGoal(goal.id);
                setConfirmDelete(false);
                router.dismissTo('/goals');
              },
              'Goal deleted.',
            )
          }
        />
        <Button label="Keep it" variant="secondary" onPress={() => setConfirmDelete(false)} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}
