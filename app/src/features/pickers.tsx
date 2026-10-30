// Time and number pickers. Android uses the system clock dialog; iOS shows a wheel in a sheet.

import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { fonts, radius, useTheme } from '@/lib/theme';
import { hhmm } from '@/lib/time';
import { Button, Chip, Sheet, T } from '@/ui';

function toDate(time: string): Date {
  const [h, m] = hhmm(time).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** A tile like "Starts 20:00" that opens a time picker. */
export function TimeTile({ label, value, onChange }: { label: string; value: string; onChange: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(toDate(value));
  const press = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: toDate(value),
        mode: 'time',
        is24Hour: true,
        onChange: (e, d) => {
          if (e.type === 'set' && d) onChange(fmt(d));
        },
      });
    } else {
      setDraft(toDate(value));
      setOpen(true);
    }
  };
  return (
    <>
      <Tile label={label} value={hhmm(value)} onPress={press} />
      {Platform.OS !== 'android' ? (
        <Sheet visible={open} onClose={() => setOpen(false)}>
          <T variant="h2">{label}</T>
          <DateTimePicker value={draft} mode="time" display="spinner" is24Hour onChange={(_, d) => d && setDraft(d)} />
          <Button
            label="Done"
            onPress={() => {
              onChange(fmt(draft));
              setOpen(false);
            }}
          />
        </Sheet>
      ) : null}
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

export function Tile({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value}`}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 64,
        borderRadius: radius.input,
        borderWidth: 1,
        borderColor: c.line,
        backgroundColor: c.surface,
        paddingHorizontal: 12,
        paddingVertical: 10,
        justifyContent: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <T variant="caption" tone="secondary">
        {label}
      </T>
      <T style={{ fontFamily: fonts.monoMedium, fontSize: 20, lineHeight: 26, color: c.text }}>{value}</T>
    </Pressable>
  );
}
