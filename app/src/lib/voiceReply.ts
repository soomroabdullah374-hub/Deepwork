// Speaks the assistant's reply: the ElevenLabs voice from the server when it works, and
// otherwise the phone's own text-to-speech (Android's engine speaks Urdu on most phones).
// speakReply() resolves when the voice has finished (or was stopped), so the conversation
// can listen again right after.

import { createAudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import * as Speech from 'expo-speech';
import { api } from './api';
import { ApiError } from './http';

export interface Reply {
  text: string;
  /** Urdu replies come with an Urdu-script copy for the voice. */
  tts: string;
  language: string;
}

let player: ReturnType<typeof createAudioPlayer> | null = null;
let lastFile: File | null = null;
// Ends the reply that is playing now (resolves its speakReply()).
let finishCurrent: (() => void) | null = null;
// A missing or rejected ElevenLabs key won't fix itself while the app is open.
let serverVoiceOff = false;
let urduVoice: Promise<string | null> | null = null;

function findUrduVoice(): Promise<string | null> {
  urduVoice ??= Speech.getAvailableVoicesAsync()
    .then((voices) => voices.find((v) => v.language.toLowerCase().startsWith('ur'))?.identifier ?? null)
    .catch(() => null);
  return urduVoice;
}

export function stopReply() {
  player?.remove();
  player = null;
  Speech.stop().catch(() => undefined);
  finishCurrent?.();
}

/** Longest a reply may take before we stop waiting for its "finished" event. */
const maxMs = (text: string) => Math.min(60_000, 4000 + text.length * 90);

function untilDone(timeoutMs: number, begin: (done: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (finishCurrent === done) finishCurrent = null;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    finishCurrent = done;
    begin(done);
  });
}

async function playFromServer(reply: Reply): Promise<boolean> {
  if (serverVoiceOff) return false;
  try {
    const { audio } = await api.speech(reply.tts || reply.text, reply.language);
    const file = new File(Paths.cache, `reply-${Date.now()}.mp3`);
    file.create();
    file.write(audio, { encoding: 'base64' });
    stopReply();
    if (lastFile?.exists) lastFile.delete();
    lastFile = file;
    const p = createAudioPlayer({ uri: file.uri });
    player = p;
    await untilDone(maxMs(reply.tts || reply.text), (done) => {
      const sub = p.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) {
          sub.remove();
          done();
        }
      });
      p.play();
    });
    return true;
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'tts_auth' || err.code === 'tts_not_configured')) serverVoiceOff = true;
    return false;
  }
}

function speakOnPhone(text: string, options: Speech.SpeechOptions): Promise<void> {
  return untilDone(maxMs(text), (done) => Speech.speak(text, { ...options, onDone: done, onStopped: done, onError: done }));
}

export async function speakReply(reply: Reply): Promise<void> {
  if (await playFromServer(reply)) return;
  stopReply();
  if (reply.language === 'en') return speakOnPhone(reply.tts || reply.text, { language: 'en-US' });
  const voice = await findUrduVoice();
  if (voice) return speakOnPhone(reply.tts || reply.text, { language: 'ur-PK', voice });
  // No Urdu voice on this phone: Roman Urdu reads well enough with an Indian English voice.
  if (reply.language === 'ur-Latn') return speakOnPhone(reply.text, { language: 'en-IN' });
}
