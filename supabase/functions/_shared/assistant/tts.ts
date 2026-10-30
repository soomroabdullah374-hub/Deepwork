// Voice replies with ElevenLabs. Urdu replies arrive in Urdu script (reply_tts), which
// eleven_v3 pronounces far better than romanised text.

import { config } from '../env.ts';
import { fetchWithTimeout, HttpError, toBase64 } from '../http.ts';

export async function speak(
  text: string,
  language: string,
): Promise<{ audio: string; bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  const el = config.elevenLabs;
  if (!el.apiKey) {
    throw new HttpError(503, 'tts_not_configured', 'Voice replies are not set up yet: add ELEVENLABS_API_KEY to the Supabase Edge Function secrets.');
  }
  const urdu = language === 'ur' || language === 'ur-Latn' || /[؀-ۿ]/.test(text);
  const model = urdu ? el.modelUrdu : el.modelEnglish;
  const res = await fetchWithTimeout(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(el.voiceId)}?output_format=mp3_44100_64`,
    {
      method: 'POST',
      headers: { 'xi-api-key': el.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: text.slice(0, 600),
        model_id: model,
        ...(urdu ? { language_code: 'ur' } : {}),
      }),
    },
    30_000,
  );
  if (res.status === 401) throw new HttpError(503, 'tts_auth', 'The ElevenLabs key was rejected.');
  if (!res.ok) {
    console.error('elevenlabs failed', res.status, (await res.text()).slice(0, 300));
    throw new HttpError(502, 'tts_failed', 'Could not create the voice reply.');
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { audio: toBase64(bytes), bytes, mime: 'audio/mpeg' };
}
