// Turning a Scribe transcript (the JSON video-use's transcribe.py writes) into the text of a voice
// note (W6 · CVP-115). Pure: no files, no processes. The joining rules are fixed so that Hebrew,
// English and mixed notes come out the same every time:
//
//   - only the entries typed "word" (or with no type) count; "spacing" and "audio_event" entries
//     ("[מוזיקה]", "(laughs)") are left out, because the text is what the owner said
//   - each word is trimmed, empty ones are skipped, the rest are joined with one space (this is
//     how video-use's own pack_transcripts.py builds phrase text)
//   - a `words` array with no word in it gives '' (the top-level `text` holds the audio events, so
//     it is never used then); the top-level `text` is used only when there is no `words` array
//   - the result is tidied: NFC, direction marks removed (the text is kept in logical order and
//     the UI shows it with dir=auto), runs of whitespace become one space, no space before
//     , . ! ? ; : … or a closing bracket, none after an opening bracket or a Hebrew maqaf
//
// Quotes and hyphens are left alone (ה-CTA stays), and nothing is cut short.

import { join, parse } from 'node:path';

/** The folder transcribe.py writes transcripts into, inside its --edit-dir. */
export const VOICE_TRANSCRIPTS_DIR = 'transcripts';

/** <outDir>/transcripts/<audio stem>.json: where transcribe.py writes (its transcript_path, track 0). */
export function transcriptPathFor(audioPath: string, outDir: string): string {
  return join(outDir, VOICE_TRANSCRIPTS_DIR, `${parse(audioPath).name}.json`);
}

/** A two-letter lower-case code like "he" (the brief's rule, /^[a-z]{2}$/), else null. */
export function normalizeLanguage(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z]{2}$/.test(value) ? value : null;
}

// U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function tidyTranscript(text: string): string {
  return text
    .normalize('NFC')
    .replace(BIDI_CONTROLS, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:…)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/־\s+/g, '־') // the maqaf
    .trim();
}

/** The words of a Scribe transcript, joined; '' when it has none. */
export function transcriptText(json: unknown): string {
  if (!isPlainObject(json)) return '';
  if (Array.isArray(json.words)) {
    const tokens: string[] = [];
    for (const word of json.words) {
      if (!isPlainObject(word)) continue;
      if (word.type !== undefined && word.type !== 'word') continue;
      if (typeof word.text === 'string' && word.text.trim() !== '') tokens.push(word.text.trim());
    }
    return tidyTranscript(tokens.join(' '));
  }
  return typeof json.text === 'string' ? tidyTranscript(json.text) : '';
}
