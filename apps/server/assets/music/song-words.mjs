// Where a song's words start, for the music script's `song --lyrics-at` (a song that opens with its
// own instrumental intro and sings when the picture says so). Scribe (ElevenLabs speech to text)
// listens to the first stretch of the song and the first word it hears is where the singing starts.
// The script cuts the part so that word lands on the moment it was asked to. Plain Node, no
// dependencies, so it runs from the engine's assets/ folder in src and dist alike.
//
// Nothing here throws for the song's sake: no key, no network, a song with no words in its first
// two minutes all answer `{ ms: null, why }`, and the script then keeps the part it found by
// loudness and says so.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** How the first words are looked for. */
export const WORDS = {
  base: 'https://api.elevenlabs.io',
  model: 'scribe_v1',
  /** How much of the song's start is listened to (the first words come long before this). */
  listenMs: 120_000,
  timeoutMs: 90_000,
};

/**
 * The start in ms of the first word in Scribe's answer, or `null`: its first `word` (not a spacing
 * or an audio event) that has a letter in it.
 */
export function firstWordMs(answer) {
  const words = Array.isArray(answer?.words) ? answer.words : [];
  for (const word of words) {
    if (word?.type !== undefined && word.type !== 'word') continue;
    if (typeof word?.text !== 'string' || !/\p{L}/u.test(word.text)) continue;
    const start = Number(word.start);
    if (Number.isFinite(start) && start >= 0) return Math.round(start * 1000);
  }
  return null;
}

/**
 * Sends `file` (the song's first stretch, a small mp3) to Scribe and answers `{ ms, why }`: where
 * the first word starts in the file, or `ms: null` and one plain sentence for why not. `base` is the
 * API's address (MUSIC_API_BASE in the tests); the key goes in a header and nowhere else.
 */
export async function firstSungWordMs({
  file,
  key,
  base = WORDS.base,
  timeoutMs = WORDS.timeoutMs,
}) {
  if (typeof key !== 'string' || key === '') {
    return { ms: null, why: 'there is no ElevenLabs key to listen with' };
  }
  const form = new FormData();
  form.set('model_id', WORDS.model);
  form.set('timestamps_granularity', 'word');
  form.set('tag_audio_events', 'false');
  form.set('diarize', 'false');
  form.set('file', new Blob([readFileSync(file)], { type: 'audio/mpeg' }), basename(file));
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': key, accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ms: null, why: `ElevenLabs answered ${res.status} when listening` };
    const ms = firstWordMs(await res.json());
    return ms === null
      ? { ms: null, why: 'no words were heard in the first two minutes' }
      : { ms, why: null };
  } catch (err) {
    const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ms: null,
      why: slow ? 'ElevenLabs did not answer in time' : 'ElevenLabs could not be reached',
    };
  }
}
