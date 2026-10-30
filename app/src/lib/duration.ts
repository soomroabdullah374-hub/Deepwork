// Typed lengths: "45", "45m", "90 min", "1h 30m", "1:30", "2.5 hours", "half an hour", and
// Roman Urdu ("aadha ghanta", "dedh ghanta", "dhai ghante", "sawa 2 ghante", "sarhe 3
// ghante", "paune 2 ghante", "45 mint"). A bare number is minutes. Returns whole minutes,
// or null when the text isn't a length.

const HOUR = String.raw`(?:h|hr|hrs|hour|hours|ghanta|ghante|ghanton|gh)`;
const MIN = String.raw`(?:m|min|mins|minute|minutes|mint|mnt)`;

// Words that are a number of hours on their own (with or without "ghanta").
const URDU_HOURS: Record<string, number> = { aadha: 0.5, adha: 0.5, paun: 0.75, dedh: 1.5, derh: 1.5, dhai: 2.5, dhaai: 2.5, adhai: 2.5, arhai: 2.5 };
// "sawa 2" = 2¼, "sarhe 3" = 3½, "paune 2" = 1¾.
const URDU_STEP: Record<string, number> = { sawa: 0.25, sarhe: 0.5, saade: 0.5, sade: 0.5, paune: -0.25 };

export function parseDuration(input: string): number | null {
  let s = input.trim().toLowerCase().replace(/,/g, '.').replace(/\s+/g, ' ');
  if (!s) return null;
  s = s.replace(/\b(an?|one)\b/g, '1').replace(/\band\b/g, ' ').replace(/\s+/g, ' ').trim();

  // English phrases
  if (/^(1 )?half(-| )?(1 )?(hour|hr)$/.test(s) || s === 'half 1 hour') return 30;
  if (/^(1 )?quarter(-| )?(1 )?(hour|hr)$/.test(s)) return 15;

  // h:mm
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  // Roman Urdu fractions: "dedh ghanta", "sawa 2 ghante", "paune 2", "sarhe 3 ghante"
  const urduWord = new RegExp(`^(${Object.keys(URDU_HOURS).join('|')})( ${HOUR})?$`).exec(s);
  if (urduWord) return Math.round(URDU_HOURS[urduWord[1]] * 60);
  const urduStep = new RegExp(`^(${Object.keys(URDU_STEP).join('|')}) (\\d+)( ${HOUR})?$`).exec(s);
  if (urduStep) return Math.round((Number(urduStep[2]) + URDU_STEP[urduStep[1]]) * 60);
  const sawaAlone = /^sawa( (ghanta|ghante))?$/.exec(s);
  if (sawaAlone) return 75;

  // "1h 30m", "1 hour 30", "2.5 hours", "90 min", "1h30"
  const full = new RegExp(`^(?:(\\d+(?:\\.\\d+)?) ?${HOUR})?(?: ?(\\d+(?:\\.\\d+)?) ?(?:${MIN})?)?$`).exec(s);
  if (full && (full[1] !== undefined || full[2] !== undefined)) {
    const hours = full[1] !== undefined ? Number(full[1]) : 0;
    const minutes = full[2] !== undefined ? Number(full[2]) : 0;
    const total = Math.round(hours * 60 + minutes);
    return total > 0 ? total : null;
  }
  return null;
}
