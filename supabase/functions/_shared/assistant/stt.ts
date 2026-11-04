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

// Urdu said with an accent, quietly or with English words mixed in is sometimes detected as
// English and written out phonetically ("Kalsam Sat Bhagi…"), with low word confidence.
// Such results get a second pass as Urdu, and the more confident transcript wins.
const URDU_RETRY_BELOW = 0.8;

function urduBodies(audioUrl: string, keyterms: string[]): Record<string, unknown>[] {
  const terms = keyterms.filter((t) => t.trim().length > 1 && t.split(/\s+/).length <= 6).slice(0, 100);
  return [
    { audio_url: audioUrl, speech_models: ['universal-3-pro', 'universal-2'], language_code: 'ur', ...(terms.length ? { keyterms_prompt: terms } : {}) },
    { audio_url: audioUrl, speech_models: ['universal-3-pro', 'universal-2'], language_code: 'ur' },
    { audio_url: audioUrl, speech_model: 'universal', language_code: 'ur' },
    { audio_url: audioUrl, language_code: 'ur' },
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

  const first = await run(auth, requestBodies(upload_url, keyterms));
  if (first.language !== 'en' || (first.confidence ?? 1) >= URDU_RETRY_BELOW || !first.text) return first;
  try {
    const urdu = await run(auth, urduBodies(upload_url, keyterms));
    return urdu.text && (urdu.confidence ?? 0) > (first.confidence ?? 0) ? urdu : first;
  } catch {
    return first;
  }
}

/** Submit with the first request body AssemblyAI accepts, then wait for the transcript. */
async function run(auth: { authorization: string }, bodies: Record<string, unknown>[]): Promise<Transcript> {
  let job: { id: string } | null = null;
  let lastError = '';
  for (const body of bodies) {
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

// ───────────────────────── quick transcription for calls
// A phone call can't wait for upload-then-poll, so calls use Groq's Whisper when the LLM
// key is a Groq key (one request, well under a second for a short reply), and AssemblyAI
// otherwise. Urdu speakers get language "ur" (Urdu script out; Whisper otherwise often
// writes Urdu speech in Hindi letters). Whisper makes up words for silence and noise
// ("you", "Thank you."), so segments that are probably not speech are dropped.

export interface WhisperSegment {
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

// What Whisper says over silence or noise, said on its own.
const STOCK = new Set([
  'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching',
  'bye', 'so', 'okay', 'ok', 'the end', 'subscribe', 'شکریہ', 'سبسکرائب کریں', 'اللہ حافظ',
]);
const plain = (t: string) => t.toLowerCase().replace(/[.,!?…۔،؟"']/g, ' ').replace(/\s+/g, ' ').trim();

/** The words that were really spoken: segments that are probably silence or noise go. */
export function spokenText(segments: WhisperSegment[]): string {
  const kept = segments.filter((s) => {
    const noSpeech = s.no_speech_prob ?? 0;
    const logprob = s.avg_logprob ?? 0;
    if (noSpeech >= 0.6 && logprob <= -0.7) return false; // Whisper's own silence test
    if (noSpeech >= 0.8) return false; // almost surely not speech
    // a stock phrase over something that may not be speech at all
    return !(STOCK.has(plain(s.text)) && (noSpeech >= 0.2 || logprob <= -0.6));
  });
  return kept.map((s) => s.text).join('').trim();
}

export async function transcribeQuick(
  audio: Uint8Array<ArrayBuffer>,
  opts: { mime?: string; urdu?: boolean; keyterms?: string[] } = {},
): Promise<Pick<Transcript, 'text' | 'language' | 'confidence'>> {
  const llm = config.llm;
  if (llm.provider !== 'groq' || !llm.apiKey) {
    const t = await transcribe(audio, opts.keyterms ?? []);
    return { text: t.text, language: t.language, confidence: t.confidence };
  }
  const form = new FormData();
  form.append('file', new Blob([audio], { type: opts.mime ?? 'audio/mp4' }), 'reply.m4a');
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (opts.urdu) form.append('language', 'ur');
  const prompt = (opts.keyterms ?? []).join(', ').slice(0, 400);
  if (prompt) form.append('prompt', prompt);
  const res = await fetchWithTimeout(`${llm.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${llm.apiKey}` },
    body: form,
  }, 30_000);
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new HttpError(503, 'stt_auth', 'The speech key was rejected. Check LLM_API_KEY in the Supabase secrets.');
  }
  if (!res.ok) {
    console.error('whisper failed', res.status, (await res.text()).slice(0, 300));
    throw new HttpError(502, 'stt_failed', "Couldn't hear that clearly. Please say it again.");
  }
  const out = await res.json() as { text?: string; language?: string; segments?: WhisperSegment[] };
  const segments = out.segments ?? [];
  // how sure Whisper was, per segment (no words), to tune the silence test
  console.log('whisper', segments.map((s) => `${(s.no_speech_prob ?? 0).toFixed(2)}/${(s.avg_logprob ?? 0).toFixed(2)}/${s.text.trim().split(/\s+/).length}w`).join(' '));
  const text = segments.length ? spokenText(segments) : (out.text ?? '').trim();
  const kept = segments.filter((s) => text.includes(s.text.trim()));
  const confidence = kept.length ? Math.exp(kept.reduce((sum, s) => sum + (s.avg_logprob ?? 0), 0) / kept.length) : null;
  return { text, language: out.language ?? (opts.urdu ? 'ur' : null), confidence };
}
