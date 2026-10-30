// Speaks the assistant's reply: the ElevenLabs voice from the server when it works, and
// otherwise the phone's own text-to-speech (Android's engine speaks Urdu on most phones).

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
    player = createAudioPlayer({ uri: file.uri });
    player.play();
    return true;
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'tts_auth' || err.code === 'tts_not_configured')) serverVoiceOff = true;
    return false;
  }
}

export async function speakReply(reply: Reply): Promise<void> {
  if (await playFromServer(reply)) return;
  stopReply();
  if (reply.language === 'en') {
    Speech.speak(reply.tts || reply.text, { language: 'en-US' });
    return;
  }
  const voice = await findUrduVoice();
  if (voice) {
    Speech.speak(reply.tts || reply.text, { language: 'ur-PK', voice });
  } else if (reply.language === 'ur-Latn') {
    // No Urdu voice on this phone: Roman Urdu reads well enough with an Indian English voice.
    Speech.speak(reply.text, { language: 'en-IN' });
  }
}
