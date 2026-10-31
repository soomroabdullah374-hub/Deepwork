import { describe, expect, it } from '@jest/globals';
import { vadStart, vadStep } from '../vad';

const FRAME = 80;

/** Feeds levels (one per 80 ms frame); returns the first event and when it fired. */
function run(levels: (number | undefined)[]): { event: string | null; atMs: number } {
  let s = vadStart();
  for (const db of levels) {
    const [next, event] = vadStep(s, db, FRAME);
    s = next;
    if (event) return { event, atMs: s.elapsedMs };
  }
  return { event: null, atMs: s.elapsedMs };
}

const span = (ms: number, db: number | undefined) => Array<number | undefined>(Math.round(ms / FRAME)).fill(db);

describe('end of speech', () => {
  it('gives up after 8 s of silence', () => {
    expect(run(span(10_000, -50))).toEqual({ event: 'no_speech', atMs: 8000 });
  });

  it('ends 1.5 s after you stop talking', () => {
    const r = run([...span(1000, -50), ...span(1500, -20), ...span(3000, -50)]);
    expect(r.event).toBe('end');
    expect(r.atMs).toBeGreaterThanOrEqual(4000);
    expect(r.atMs).toBeLessThanOrEqual(4100);
  });

  it('waits through short pauses between words', () => {
    const word = [...span(480, -18), ...span(400, -48)];
    const r = run([...span(800, -48), ...word, ...word, ...word, ...word, ...span(3000, -48)]);
    expect(r.event).toBe('end');
    // the last word ends at 800 + 4 × 880 - 400 = 3920 ms
    expect(r.atMs).toBeGreaterThanOrEqual(3920 + 1500);
  });

  it('a steady fan does not count as speech', () => {
    const r = run([...span(2000, -35), ...span(2000, -12), ...span(4000, -35)]);
    expect(r.event).toBe('end');
    expect(r.atMs).toBeGreaterThanOrEqual(5500);
  });

  it('skips the no-signal readings at the start', () => {
    expect(run([-160, -160, undefined, ...span(9000, -45)])).toEqual({ event: 'no_speech', atMs: 8000 });
  });

  it('keeps listening through fast speech with shallow dips', () => {
    const fast = Array.from({ length: 60 }, (_, i) => (i % 2 ? -27 : -18));
    const r = run([...span(1000, -50), ...fast, ...span(2000, -50)]);
    expect(r.event).toBe('end');
    expect(r.atMs).toBeGreaterThanOrEqual(1000 + 60 * FRAME + 1400);
  });

  it('sends a loud reply that never looked like speech rather than drop it', () => {
    // talking from the first frame with shallow dips: no quiet floor to compare with
    const r = run(Array.from({ length: 120 }, (_, i) => (i % 2 ? -27 : -18)));
    expect(r).toEqual({ event: 'end', atMs: 8000 });
  });

  it('a short "haan" is enough', () => {
    const r = run([...span(1000, -50), ...span(240, -15), ...span(2000, -50)]);
    expect(r.event).toBe('end');
  });
});
