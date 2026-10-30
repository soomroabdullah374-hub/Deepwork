// Recording for the assistant: mono AAC with metering (drives the waveform), hard stop
// at 60 seconds, then upload for transcription.

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

export function useVoice(onAutoStop?: (t: Transcript | null) => void) {
  const recorder = useAudioRecorder(OPTIONS);
  const status = useAudioRecorderState(recorder, 80);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<VoicePhase>('idle');
  phaseRef.current = phase;

  const stop = useCallback(async (): Promise<Transcript | null> => {
    if (timer.current) clearTimeout(timer.current);
    if (phaseRef.current !== 'recording') return null;
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    const uri = recorder.uri;
    if (!uri) {
      setPhase('idle');
      return null;
    }
    setPhase('transcribing');
    try {
      return await api.transcribe(uri);
    } finally {
      setPhase('idle');
    }
  }, [recorder]);

  const start = useCallback(async () => {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      throw new ApiError(0, 'mic_denied', 'DeepWork needs the microphone to hear you. You can allow it in system settings, or type instead.');
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setPhase('recording');
    timer.current = setTimeout(async () => {
      const t = await stop().catch(() => null);
      onAutoStop?.(t);
    }, MAX_RECORDING_MS);
  }, [onAutoStop, recorder, stop]);

  const cancel = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (phaseRef.current === 'recording') await recorder.stop().catch(() => undefined);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    setPhase('idle');
  }, [recorder]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // dBFS (about -60 quiet … 0 loud) → 0…1
  const db = typeof status.metering === 'number' ? status.metering : -60;
  const level = phase === 'recording' ? Math.max(0, Math.min(1, (db + 55) / 50)) : 0;

  return { phase, start, stop, cancel, level, durationMs: status.durationMillis };
}
