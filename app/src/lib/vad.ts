// End of speech from the recorder's level readings (dBFS, about every 80 ms), so the
// assistant stops listening when you pause instead of waiting for a tap.
//
// The noise floor is the quietest reading of the last few seconds, so it follows the room
// (a fan or traffic stops counting as speech) while the pauses between words keep it low.
// Once you are talking, a smaller margin keeps counting you as talking, so fast speech
// with shallow dips isn't cut off. Readings of "no signal" (Android reports -160 before
// the first sample) are skipped.

export const VAD = {
  /** Speech starts this many dB over the floor, and above `quietest`. */
  margin: 10,
  /** While talking (a word in the last `holdMs`), this margin is enough. */
  holdMargin: 5,
  holdMs: 400,
  quietest: -50,
  /** Window for the noise floor. */
  floorMs: 3000,
  /** This much speech counts as having said something. */
  minSpeechMs: 160,
  /** Then this long a pause ends the turn. */
  endSilenceMs: 1500,
  /** Nothing said for this long: give up, unless something loud was heard (then send it). */
  noSpeechMs: 8000,
  loud: -30,
};

export interface VadState {
  elapsedMs: number;
  speechMs: number;
  silenceMs: number;
  peak: number;
  recent: { t: number; db: number }[];
}

export type VadEvent = 'end' | 'no_speech' | null;

export const vadStart = (): VadState => ({ elapsedMs: 0, speechMs: 0, silenceMs: 0, peak: -160, recent: [] });

export function vadStep(s: VadState, db: number | undefined, dtMs: number): [VadState, VadEvent] {
  const elapsedMs = s.elapsedMs + dtMs;
  const real = typeof db === 'number' && Number.isFinite(db) && db > -100;
  const floor = s.recent.length ? Math.min(...s.recent.map((r) => r.db)) : null;
  const talking = s.speechMs > 0 && s.silenceMs < VAD.holdMs;
  const speech = real && floor !== null && db > floor + (talking ? VAD.holdMargin : VAD.margin) && db > VAD.quietest;
  const recent = real ? [...s.recent, { t: elapsedMs, db }] : s.recent;
  const next: VadState = {
    elapsedMs,
    speechMs: s.speechMs + (speech ? dtMs : 0),
    silenceMs: speech ? 0 : s.silenceMs + dtMs,
    peak: real ? Math.max(s.peak, db) : s.peak,
    recent: recent.filter((r) => r.t > elapsedMs - VAD.floorMs),
  };
  if (next.speechMs >= VAD.minSpeechMs) return [next, next.silenceMs >= VAD.endSilenceMs ? 'end' : null];
  if (next.elapsedMs >= VAD.noSpeechMs) return [next, next.peak > VAD.loud ? 'end' : 'no_speech'];
  return [next, null];
}
