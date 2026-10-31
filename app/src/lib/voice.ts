// Recording for the assistant: mono AAC with metering (drives the waveform and the pause
// detection), hard stop at 60 seconds, then upload for transcription.

import {
  type RecordingOptions,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ApiError } from './http';
import type { Transcript } from './types';
import { vadStart, vadStep } from './vad';

const OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
};

export const MAX_RECORDING_MS = 60_000;

export type VoicePhase = 'idle' | 'recording' | 'transcribing';

/** Why a recording ended without a tap: a pause after speech, nothing said, or the time limit. */
export type AutoStop = 'pause' | 'quiet' | 'max';

export function useVoice({
  onAutoStop,
  endOnPause = false,
}: {
  /**
   * Called when recording stops by itself, with the transcript (null when nothing was
   * said), or the error when the clip couldn't be transcribed.
   */
  onAutoStop?: (t: Transcript | null, why: AutoStop, error?: unknown) => void;
  /** Stop when you pause after speaking, and give up after a long silence. */
  endOnPause?: boolean;
} = {}) {
  const recorder = useAudioRecorder(OPTIONS);
  const status = useAudioRecorderState(recorder, 80);
  const [phase, setPhaseState] = useState<VoicePhase>('idle');
  // the ref is the truth for guards (a re-render must not reopen a stop in progress)
  const phaseRef = useRef<VoicePhase>('idle');
  const setPhase = useCallback((p: VoicePhase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callback = useRef(onAutoStop);
  callback.current = onAutoStop;
  const vad = useRef(vadStart());
  const lastLevelAt = useRef<number | null>(null);
  // one automatic stop per recording
  const ending = useRef(false);

  const stop = useCallback(async (): Promise<Transcript | null> => {
    if (timer.current) clearTimeout(timer.current);
    if (phaseRef.current !== 'recording') return null;
    setPhase('transcribing');
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    const uri = recorder.uri;
    if (!uri) {
      setPhase('idle');
      return null;
    }
    try {
      return await api.transcribe(uri);
    } finally {
      setPhase('idle');
    }
  }, [recorder, setPhase]);

  const cancel = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const wasRecording = phaseRef.current === 'recording';
    setPhase('idle');
    if (wasRecording) await recorder.stop().catch(() => undefined);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
  }, [recorder, setPhase]);

  const autoStop = useCallback(
    async (why: AutoStop) => {
      if (ending.current || phaseRef.current !== 'recording') return;
      ending.current = true;
      if (why === 'quiet') {
        await cancel();
        callback.current?.(null, why);
        return;
      }
      try {
        callback.current?.(await stop(), why);
      } catch (err) {
        callback.current?.(null, why, err);
      }
    },
    [cancel, stop],
  );

  const start = useCallback(async () => {
    if (phaseRef.current === 'recording') return; // already listening (a double tap)
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      throw new ApiError(0, 'mic_denied', 'DeepWork needs the microphone to hear you. You can allow it in system settings, or type instead.');
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    vad.current = vadStart();
    lastLevelAt.current = null;
    ending.current = false;
    setPhase('recording');
    timer.current = setTimeout(() => autoStop('max'), MAX_RECORDING_MS);
  }, [autoStop, recorder, setPhase]);

  // Pause detection on each level reading (about every 80 ms). Without level readings
  // (some devices), recording simply runs until a tap or the time limit.
  useEffect(() => {
    if (!endOnPause || phase !== 'recording' || typeof status.metering !== 'number') return;
    const now = Date.now();
    const dt = lastLevelAt.current === null ? 80 : Math.min(500, now - lastLevelAt.current);
    lastLevelAt.current = now;
    const [next, event] = vadStep(vad.current, status.metering, dt);
    vad.current = next;
    if (event === 'end') autoStop('pause');
    else if (event === 'no_speech') autoStop('quiet');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.durationMillis, status.metering]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // dBFS (about -60 quiet … 0 loud) → 0…1
  const db = typeof status.metering === 'number' ? status.metering : -60;
  const level = phase === 'recording' ? Math.max(0, Math.min(1, (db + 55) / 50)) : 0;

  return { phase, start, stop, cancel, level, durationMs: status.durationMillis };
}
