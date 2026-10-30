// Speech to text with AssemblyAI: upload, then transcribe with language detection limited
// to English and Urdu (mixed Roman Urdu speech is still Urdu speech). Real-time streaming
// does not cover Urdu, so this is upload-then-transcribe (about 1–3 s for a short clip).

import { config } from '../env.ts';
import { fetchWithTimeout, HttpError } from '../http.ts';

const API = 'https://api.assemblyai.com/v2';

export interface Transcript {
  text: string;
  language: string | null;
  confidence: number | null;
  language_confidence: number | null;
  words: { text: string; start: number; end: number; confidence: number }[];
  speech_model: string | null;
}

// Most capable request first; each later one drops a parameter some models refuse.
function requestBodies(audioUrl: string, keyterms: string[]): Record<string, unknown>[] {
  const detection = {
    language_detection: true,
    language_detection_options: { expected_languages: ['en', 'ur'], fallback_language: 'auto' },
  };
  const terms = keyterms.filter((t) => t.trim().length > 1 && t.split(/\s+/).length <= 6).slice(0, 100);
  return [
    { audio_url: audioUrl, speech_models: ['universal-3-pro', 'universal-2'], ...detection, ...(terms.length ? { keyterms_prompt: terms } : {}) },
    { audio_url: audioUrl, speech_models: ['universal-3-pro', 'universal-2'], ...detection },
    { audio_url: audioUrl, speech_model: 'universal', ...detection },
    { audio_url: audioUrl, language_detection: true },
  ];
}

export async function transcribe(audio: Uint8Array<ArrayBuffer>, keyterms: string[]): Promise<Transcript> {
  const key = config.assemblyAiKey;
  if (!key) {
    throw new HttpError(503, 'stt_not_configured', 'Voice input is not set up yet: add ASSEMBLYAI_API_KEY to the Supabase Edge Function secrets.');
  }
  const auth = { authorization: key };

  const up = await fetchWithTimeout(`${API}/upload`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/octet-stream' },
    body: audio,
  }, 30_000);
  if (up.status === 401) throw new HttpError(503, 'stt_auth', 'The AssemblyAI key was rejected.');
  if (!up.ok) throw new HttpError(502, 'stt_failed', 'Could not upload the recording.');
  const { upload_url } = await up.json();

  let job: { id: string } | null = null;
  let lastError = '';
  for (const body of requestBodies(upload_url, keyterms)) {
    const res = await fetchWithTimeout(`${API}/transcript`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 20_000);
    if (res.ok) {
      job = await res.json();
      break;
    }
    lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status !== 400) break;
  }
  if (!job) {
    console.error('assemblyai submit failed', lastError);
    throw new HttpError(502, 'stt_failed', 'Could not start the transcription.');
  }

  const started = Date.now();
  while (Date.now() - started < 45_000) {
    await new Promise((r) => setTimeout(r, 700));
    const res = await fetchWithTimeout(`${API}/transcript/${job.id}`, { headers: auth }, 15_000);
    if (!res.ok) continue;
    const t = await res.json();
    if (t.status === 'completed') {
      return {
        text: (t.text ?? '').trim(),
        language: t.language_code ?? null,
        // Word-level confidence only: language confidence is naturally low for mixed
        // English and Roman Urdu speech even when every word was heard right.
        confidence: typeof t.confidence === 'number' ? t.confidence : null,
        language_confidence: typeof t.language_confidence === 'number' ? t.language_confidence : null,
        words: (t.words ?? []).map((w: { text: string; start: number; end: number; confidence: number }) => ({
          text: w.text, start: w.start, end: w.end, confidence: w.confidence,
        })),
        speech_model: t.speech_model ?? null,
      };
    }
    if (t.status === 'error') {
      console.error('assemblyai error', t.error);
      throw new HttpError(422, 'stt_failed', 'I could not hear that clearly. Please try again.');
    }
  }
  throw new HttpError(504, 'stt_timeout', 'Transcription took too long. Please try again.');
}
