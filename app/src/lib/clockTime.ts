// Typed times of day: "20:30", "8:30 pm", "830", "8.30", "noon", "midnight", and Roman Urdu
// ("raat 8 baje", "subah 7", "shaam 6", "saade 8", "sawa 9", "paune 10", "dedh baje").
// Returns "HH:MM" (24-hour), or null when the text isn't a time. A bare hour is taken as
// written in 24-hour time ("8" is 08:00), so the picker can show what it understood.

type Period = 'morning' | 'afternoon' | 'evening' | 'night';

const PERIODS: Record<string, Period> = {
  am: 'morning', subah: 'morning', subha: 'morning', subh: 'morning', savere: 'morning', sawere: 'morning', morning: 'morning',
  dopahar: 'afternoon', dopehar: 'afternoon', dupahar: 'afternoon', dupehar: 'afternoon', afternoon: 'afternoon',
  pm: 'evening', shaam: 'evening', sham: 'evening', evening: 'evening',
  raat: 'night', rat: 'night', night: 'night', tonight: 'night',
};
// Words that carry no time: "8 baje", "at 8", "8 o'clock", "2030 hrs".
const FILLER = new Set(['baje', 'bajay', 'bje', 'baj', 'oclock', 'at', 'ko', 'ke', 'hrs', 'hr', 'h']);
// "saade 8" = 8:30, "sawa 8" = 8:15, "paune 8" = 7:45
const STEPS: Record<string, number> = { saade: 30, sade: 30, sarhe: 30, saarhe: 30, sadhe: 30, sawa: 15, paune: -15 };
// "dedh baje" = 1:30, "dhai baje" = 2:30
const WORDS: Record<string, number> = { dedh: 90, derh: 90, dairh: 90, dhai: 150, dhaai: 150, adhai: 150, arhai: 150 };

const pad = (n: number) => String(n).padStart(2, '0');

function withPeriod(h: number, m: number, period: Period | null): number | null {
  if (m < 0 || m > 59 || h < 0) return null;
  if (!period || h > 12) return h <= 23 && !(h > 12 && period === 'morning') ? h * 60 + m : null;
  switch (period) {
    case 'morning':
      return (h === 12 ? 0 : h) * 60 + m;
    case 'afternoon':
    case 'evening':
      return (h === 12 ? 12 : h + 12) * 60 + m;
    case 'night':
      return (h === 12 ? 0 : h <= 4 ? h : h + 12) * 60 + m;
  }
}

export function parseClock(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s
    .replace(/o['’]?\s?clock/g, ' oclock ')
    .replace(/\b([ap])\.?\s?m\b\.?/g, ' $1m ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/aadhi raat/g, 'midnight')
    .replace(/\s+/g, ' ')
    .trim();

  let period: Period | null = null;
  const words: string[] = [];
  for (const w of s.split(' ')) {
    if (PERIODS[w]) period = PERIODS[w];
    else if (!FILLER.has(w)) words.push(w);
  }
  const rest = words.join(' ');

  let minutes: number | null = null;
  if (rest === 'noon' || rest === 'midday') minutes = 12 * 60;
  else if (rest === 'midnight') minutes = 0;
  else if (WORDS[rest] !== undefined) minutes = withPeriod(Math.floor(WORDS[rest] / 60), WORDS[rest] % 60, period);
  else {
    const step = /^([a-z]+) (\d{1,2})$/.exec(rest);
    const clock = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(rest);
    const compact = /^(\d{3,4})$/.exec(rest);
    if (step && STEPS[step[1]] !== undefined) {
      const h = Number(step[2]);
      const total = h * 60 + STEPS[step[1]];
      if (h >= 1 && h <= 12) minutes = withPeriod(Math.floor(total / 60), total % 60, period);
      else if (h <= 23 && !period) minutes = total;
    } else if (clock) {
      minutes = withPeriod(Number(clock[1]), clock[2] !== undefined ? Number(clock[2]) : 0, period);
    } else if (compact) {
      const n = Number(compact[1]);
      minutes = withPeriod(Math.floor(n / 100), n % 100, period);
    }
  }
  return minutes === null ? null : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
