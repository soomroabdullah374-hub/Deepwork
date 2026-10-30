// [06–09] New goal: Goal · Deadline · Plan · Rhythm.

import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import {
  DeadlineSummary,
  deadlineChoices,
  DEFAULT_RHYTHM,
  type MilestoneDraft,
  MilestoneEditor,
  MonthCalendar,
  newKey,
  RhythmEditor,
  useRhythmCheck,
} from '@/features/goal-form';
import { api } from '@/lib/api';
import { showBanner } from '@/lib/banner';
import { errorMessage } from '@/lib/http';
import { useChange, useLoadedState } from '@/lib/queries';
import { fonts, useTheme } from '@/lib/theme';
import { addDays, localDate } from '@/lib/time';
import { useVoice } from '@/lib/voice';
import { Button, Card, Chip, Field, Icon, Screen, T, TopBar } from '@/ui';

const STEPS = ['Goal', 'Deadline', 'Plan', 'Rhythm'] as const;

function Progress({ step }: { step: number }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 6 }} accessibilityLabel={`Step ${step + 1} of 4, ${STEPS[step]}`}>
      {STEPS.map((s, i) => (
        <View key={s} style={{ flex: 1, gap: 6 }}>
          <Segment on={i <= step} color={c.mark} track={c.sand} />
          <T variant="caption" tone={i === step ? 'text' : 'secondary'} style={{ fontFamily: i === step ? fonts.uiBold : fonts.ui }}>
            {s}
          </T>
        </View>
      ))}
    </View>
  );
}

function Segment({ on, color, track }: { on: boolean; color: string; track: string }) {
  const style = useAnimatedStyle(() => ({ width: withTiming(on ? '100%' : '0%', { duration: 320 }) }));
  return (
    <View style={{ height: 4, borderRadius: 2, backgroundColor: track, overflow: 'hidden' }}>
      <Animated.View style={[{ height: 4, backgroundColor: color }, style]} />
    </View>
  );
}

export default function NewGoal() {
  const { c } = useTheme();
  const state = useLoadedState();
  const tz = state.profile.timezone;
  const today = localDate(new Date(), tz);
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [deadline, setDeadline] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [drafted, setDrafted] = useState(false);
  const [rhythm, setRhythm] = useState(DEFAULT_RHYTHM);
  const { result: check, checking } = useRhythmCheck(rhythm);
  const voice = useVoice();
  const create = useChange(api.createGoal);

  const draft = async () => {
    if (!deadline) return;
    setDrafting(true);
    try {
      const d = await api.draftPlan({ title: title.trim(), why: why.trim() || undefined, deadline, rule: { weekdays: rhythm.weekdays, duration_min: rhythm.duration_min } });
      setMilestones(d.milestones.map((m) => ({ key: newKey(), title: m.title })));
      setWarning(d.warning);
      setDrafted(true);
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
      if (milestones.length === 0) setMilestones([{ key: newKey(), title: '' }]);
    } finally {
      setDrafting(false);
    }
  };

  useEffect(() => {
    if (step === 2 && !drafted && !drafting) draft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const speakTitle = async () => {
    try {
      if (voice.phase === 'recording') {
        const t = await voice.stop();
        if (t?.text) {
          const [first, ...rest] = t.text.split(/(?<=[.!?])\s+/);
          setTitle(first.replace(/[.!?]$/, '').slice(0, 80));
          if (rest.length && !why) setWhy(rest.join(' ').slice(0, 500));
        }
      } else {
        await voice.start();
      }
    } catch (err) {
      showBanner(errorMessage(err), 'danger');
    }
  };

  const canContinue = [
    title.trim().length >= 3,
    Boolean(deadline && deadline > today),
    milestones.some((m) => m.title.trim()),
    rhythm.weekdays.length > 0 && !checking && (check?.clashes.length ?? 0) === 0,
  ][step];

  const submit = () => {
    if (!deadline) return;
    create.mutate(
      {
        title: title.trim(),
        why: why.trim() || undefined,
        deadline,
        milestones: milestones.filter((m) => m.title.trim()).map((m) => ({ title: m.title.trim() })),
        rule: rhythm,
      },
      {
        onSuccess: (r) => {
          showBanner(r.conflicts.length ? `Goal created. ${r.conflicts.length} session(s) need another time.` : 'Goal created. Your sessions are booked.');
          router.replace(`/goal/${r.goal_id}`);
        },
        onError: (e) => showBanner(errorMessage(e), 'danger'),
      },
    );
  };

  const questions = ['What do you want to finish?', 'When is it due?', 'Break it into milestones', 'Set your rhythm'];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen
        footer={
          step < 3 ? (
            <Button label="Continue" iconRight="arrowRight" disabled={!canContinue} onPress={() => setStep(step + 1)} />
          ) : (
            <Button label="Create goal" disabled={!canContinue} loading={create.isPending} onPress={submit} />
          )
        }
      >
        <TopBar title="New goal" close={step === 0} onBack={step === 0 ? () => router.back() : () => setStep(step - 1)} />
        <Progress step={step} />
        <T variant="h1">{questions[step]}</T>

        {step === 0 ? (
          <Animated.View entering={FadeIn.duration(220)} style={{ gap: 16 }}>
            <Field
              label="Goal"
              value={title}
              onChangeText={(t) => setTitle(t.slice(0, 80))}
              placeholder="Finish the AI agent portfolio project"
              hint="Short and specific works best."
              counter={`${title.length}/80`}
              autoFocus
              returnKeyType="next"
            />
            <Field
              label="Why it matters · optional"
              value={why}
              onChangeText={(t) => setWhy(t.slice(0, 500))}
              placeholder="I want a project that shows I can ship an agentic system end to end."
              hint="Shown on hard days, when the reminder comes in."
              multiline
            />
            <Button
              label={voice.phase === 'recording' ? 'Listening… tap to stop' : voice.phase === 'transcribing' ? 'Writing it down…' : 'Describe it out loud instead'}
              icon="mic"
              variant="link"
              loading={voice.phase === 'transcribing'}
              onPress={speakTitle}
            />
          </Animated.View>
        ) : null}

        {step === 1 ? (
          <Animated.View entering={FadeIn.duration(220)} style={{ gap: 16 }}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {deadlineChoices(today).map((ch) => (
                <Chip key={ch.label} label={ch.label} selected={deadline === ch.date} onPress={() => setDeadline(ch.date)} />
              ))}
            </View>
            <MonthCalendar value={deadline} onChange={setDeadline} minDate={addDays(today, 1)} />
            {deadline ? <DeadlineSummary today={today} deadline={deadline} /> : <T tone="secondary">Pick a day after today.</T>}
          </Animated.View>
        ) : null}

        {step === 2 ? (
          <Animated.View entering={FadeIn.duration(220)} style={{ gap: 12 }}>
            <Card tone="ink" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {drafting ? <ActivityIndicator color="#D97757" /> : <Icon name="retry" size={22} color="#D97757" />}
              <View style={{ flex: 1 }}>
                <T variant="label" color="#FAF9F5">
                  {drafting ? 'Drafting your plan…' : 'Drafted from your goal and deadline'}
                </T>
                <T variant="caption" color="#B0AEA5">
                  Edit, reorder or remove anything.
                </T>
              </View>
              <Button label="Redraft" variant="ghost" compact style={{ backgroundColor: '#30302E' }} disabled={drafting} onPress={draft} />
            </Card>
            {warning ? (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Icon name="alert" size={18} color={c.danger} />
                <T variant="bodySm" tone="danger" style={{ flex: 1 }}>
                  {warning}
                </T>
              </View>
            ) : null}
            <MilestoneEditor items={milestones} onChange={setMilestones} />
          </Animated.View>
        ) : null}

        {step === 3 && deadline ? (
          <Animated.View entering={FadeIn.duration(220)}>
            <RhythmEditor state={state} rhythm={rhythm} onChange={setRhythm} deadline={deadline} check={check} checking={checking} />
          </Animated.View>
        ) : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}
