// Time, length and date pickers. Times and lengths can be typed ("8:30 pm", "raat 8 baje",
// "1h 30m", "dedh ghanta"), stepped, or picked on the system clock (Android) or a wheel (iOS).

import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { parseClock } from '@/lib/clockTime';
import { parseDuration } from '@/lib/duration';
import { fonts, radius, useTheme } from '@/lib/theme';
import { dayLabel, hhmm, minutesToTime, timeToMinutes } from '@/lib/time';
import { Button, Chip, Field, IconButton, Sheet, T } from '@/ui';

function toDate(time: string): Date {
  const [h, m] = hhmm(time).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

const dayMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** A tile like "Starts 20:00": type the time ("8:30 pm", "raat 8 baje"), step it, or use the clock. */
export function TimeTile({
  label,
  value,
  onChange,
  title,
  note,
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  title?: string;
  /** Shown after the time, e.g. "next day". */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(timeToMinutes(value));
  const [typed, setTyped] = useState('');
  const set = (m: number) => {
    setTyped('');
    setDraft(((m % 1440) + 1440) % 1440);
  };
  const parsed = typed.trim() ? parseClock(typed) : null;
  const typedHint = !typed.trim() ? undefined : parsed ? `= ${parsed}` : 'Try 8:30 pm, 20:30 or raat 8 baje.';
  const onType = (text: string) => {
    setTyped(text);
    const t = parseClock(text);
    if (t) setDraft(timeToMinutes(t));
  };
  const clock = () =>
    DateTimePickerAndroid.open({
      value: toDate(minutesToTime(draft)),
      mode: 'time',
      is24Hour: true,
      onChange: (e, d) => {
        if (e.type === 'set' && d) set(dayMinutes(d));
      },
    });
  return (
    <>
      <Tile
        label={label}
        value={hhmm(value)}
        note={note}
        onPress={() => {
          setDraft(timeToMinutes(value));
          setTyped('');
          setOpen(true);
        }}
      />
      <Sheet visible={open} onClose={() => setOpen(false)}>
        <T variant="h2">{title ?? label}</T>
        <Field
          label="Type it"
          value={typed}
          onChangeText={onType}
          placeholder="8:30 pm, 20:30, raat 8 baje…"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          hint={typedHint}
        />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stepper label="Hour" value={minutesToTime(draft).slice(0, 2)} onMinus={() => set(draft - 60)} onPlus={() => set(draft + 60)} />
          <Stepper label="Minute" value={minutesToTime(draft).slice(3)} onMinus={() => set(draft - 5)} onPlus={() => set(draft + 5)} />
        </View>
        {Platform.OS === 'android' ? (
          <Button label="Pick on the clock" icon="clock" variant="link" onPress={clock} style={{ alignSelf: 'center' }} />
        ) : (
          <DateTimePicker value={toDate(minutesToTime(draft))} mode="time" display="spinner" is24Hour onChange={(_, d) => d && set(dayMinutes(d))} />
        )}
        <Button
          label={`Use ${minutesToTime(draft)}`}
          onPress={() => {
            onChange(minutesToTime(draft));
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
}

/** A tile that opens a sheet of choices ("Lasts 90m", "Nudge -10m"). */
export function ChoiceTile({
  label,
  value,
  display,
  options,
  onChange,
  title,
}: {
  label: string;
  value: number;
  display: (v: number) => string;
  options: number[];
  onChange: (v: number) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tile label={label} value={display(value)} onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)}>
        <T variant="h2">{title}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {options.map((o) => (
            <Chip
              key={o}
              label={display(o)}
              mono
              selected={o === value}
              tone="kiln"
              onPress={() => {
                onChange(o);
                setOpen(false);
              }}
            />
          ))}
        </View>
      </Sheet>
    </>
  );
}

/** "45m", "2h", "1h 30m". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function Stepper({ label, value, onMinus, onPlus }: { label: string; value: number | string; onMinus: () => void; onPlus: () => void }) {
  const { c } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderRadius: radius.input,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: c.surface,
        padding: 6,
      }}
    >
      <IconButton icon="minus" label={`Less (${label.toLowerCase()})`} size={40} iconSize={18} onPress={onMinus} />
      <View style={{ alignItems: 'center' }}>
        <T style={{ fontFamily: fonts.monoMedium, fontSize: 22, lineHeight: 28, color: c.text }}>{String(value)}</T>
        <T variant="caption" tone="secondary">
          {label}
        </T>
      </View>
      <IconButton icon="plus" label={`More (${label.toLowerCase()})`} size={40} iconSize={18} onPress={onPlus} />
    </View>
  );
}

/** A tile like "Lasts 1h 30m": common lengths, any length typed ("1h 40m", "dedh ghanta"), or steppers. */
export function DurationTile({
  label,
  title,
  value,
  onChange,
  presets,
  min,
  max,
}: {
  label: string;
  title: string;
  value: number;
  onChange: (minutes: number) => void;
  presets: number[];
  min: number;
  max: number;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [typed, setTyped] = useState('');
  const set = (m: number) => {
    setTyped('');
    setDraft(Math.min(max, Math.max(min, m)));
  };
  const parsed = typed.trim() ? parseDuration(typed) : null;
  const typedHint = !typed.trim()
    ? undefined
    : parsed === null
      ? 'Try 45m, 1h 30m, 2.5h or dedh ghanta.'
      : parsed < min || parsed > max
        ? `That's ${durationLabel(parsed)}. Pick ${durationLabel(min)} to ${durationLabel(max)}.`
        : `= ${durationLabel(parsed)}`;
  const onType = (text: string) => {
    setTyped(text);
    const m = parseDuration(text);
    if (m !== null && m >= min && m <= max) setDraft(m);
  };
  return (
    <>
      <Tile
        label={label}
        value={durationLabel(value)}
        onPress={() => {
          setDraft(value);
          setTyped('');
          setOpen(true);
        }}
      />
      <Sheet visible={open} onClose={() => setOpen(false)}>
        <T variant="h2">{title}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {presets.map((o) => (
            <Chip key={o} label={durationLabel(o)} mono selected={o === draft} tone="kiln" onPress={() => set(o)} />
          ))}
        </View>
        <Field
          label="Or type it"
          value={typed}
          onChangeText={onType}
          placeholder="1h 40m, 95 min, dedh ghanta…"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          hint={typedHint}
        />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stepper label="Hours" value={Math.floor(draft / 60)} onMinus={() => set(draft - 60)} onPlus={() => set(draft + 60)} />
          <Stepper label="Minutes" value={draft % 60} onMinus={() => set(draft - 5)} onPlus={() => set(draft + 5)} />
        </View>
        <T variant="caption" tone="secondary">{`Anything from ${durationLabel(min)} to ${durationLabel(max)}.`}</T>
        <Button
          label={`Use ${durationLabel(draft)}`}
          onPress={() => {
            onChange(draft);
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const toDay = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
const fromDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** A tile like "Date Tue 3 Nov" that opens a date picker. Dates are "YYYY-MM-DD". */
export function DateTile({
  label,
  value,
  onChange,
  minimum,
  maximum,
}: {
  label: string;
  value: string;
  onChange: (date: string) => void;
  minimum?: string;
  maximum?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(toDay(value));
  const limits = { minimumDate: minimum ? toDay(minimum) : undefined, maximumDate: maximum ? toDay(maximum) : undefined };
  const press = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: toDay(value),
        mode: 'date',
        ...limits,
        onChange: (e, d) => {
          if (e.type === 'set' && d) onChange(fromDay(d));
        },
      });
    } else {
      setDraft(toDay(value));
      setOpen(true);
    }
  };
  return (
    <>
      <Tile label={label} value={dayLabel(value)} onPress={press} />
      {Platform.OS !== 'android' ? (
        <Sheet visible={open} onClose={() => setOpen(false)}>
          <T variant="h2">{label}</T>
          <DateTimePicker value={draft} mode="date" display="inline" {...limits} onChange={(_, d) => d && setDraft(d)} />
          <Button
            label="Done"
            onPress={() => {
              onChange(fromDay(draft));
              setOpen(false);
            }}
          />
        </Sheet>
      ) : null}
    </>
  );
}

export function Tile({
  label,
  value,
  note,
  active,
  onPress,
}: {
  label: string;
  value: string;
  note?: string;
  /** Highlighted, e.g. the end of a date range the next tap sets. */
  active?: boolean;
  onPress?: () => void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value}${note ? `, ${note}` : ''}`}
      accessibilityState={active === undefined ? undefined : { selected: active }}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 64,
        borderRadius: radius.input,
        borderWidth: active ? 2 : 1,
        borderColor: active ? c.mark : c.line,
        backgroundColor: c.surface,
        paddingHorizontal: active ? 11 : 12,
        paddingVertical: 10,
        justifyContent: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <T variant="caption" tone="secondary">
        {label}
      </T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 6 }}>
        <T style={{ fontFamily: fonts.monoMedium, fontSize: 20, lineHeight: 26, color: c.text }}>{value}</T>
        {note ? (
          <T variant="caption" tone="secondary">
            {note}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}
