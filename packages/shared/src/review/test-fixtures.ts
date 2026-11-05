import roundMarkdown from './fixtures/bakery-round-1.md?raw';
import seriesMarkdown from './fixtures/bakery-series-notes.md?raw';
import styleMarkdown from './fixtures/bakery-style-notes.md?raw';
import type { ReviewNoteForFile } from './notes-files.ts';

/** A text note at 0:00.0. Tests override what they care about. */
export function makeNote(overrides: Partial<ReviewNoteForFile> = {}): ReviewNoteForFile {
  return {
    atSec: 0,
    kind: 'text',
    text: 'A note.',
    audioFile: null,
    transcriptStatus: null,
    ...overrides,
  };
}

const job = 'פרומו לסוף השבוע';
const client = 'מאפיית הצפון';

/** The three notes of the §3 example. The text has spaces and a newline around it, which must be trimmed. */
const title = makeNote({ atSec: 2.43, text: '  הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.\n' });
const captions = makeNote({
  atSec: 7.8,
  kind: 'voice',
  text: 'כאן הכתוביות מכסות את הידיים של יוסי. להעלות אותן קצת, או לבחור שוט אחר.',
  audioFile: 'edit/review/voice/n2.webm',
  transcriptStatus: 'done',
});
const silence = makeNote({ atSec: 15.62, text: 'לחתוך את השתיקה לפני "בסוף השבוע".' });

/** Round 1 of the bakery job. The notes are out of order on purpose. */
export const bakeryRound = {
  job,
  client,
  round: 1,
  notes: [silence, title, captions],
  markdown: roundMarkdown,
};

/** The notes the owner marked Add to style: two Hebrew, one English, and a voice note whose transcription failed. */
export const bakeryStyle = {
  job,
  round: 1,
  notes: [
    captions,
    makeNote({ atSec: 21, text: 'End card: keep the logo up for two seconds.' }),
    title,
    makeNote({
      atSec: 12,
      kind: 'voice',
      text: null,
      audioFile: 'edit/review/voice/n4.webm',
      transcriptStatus: 'failed',
    }),
  ],
  markdown: styleMarkdown,
};

/** The notes the owner marked Series on the same job, an episode of the series שאלות נפוצות. */
export const bakerySeries = {
  job,
  series: 'שאלות נפוצות',
  round: 1,
  notes: bakeryStyle.notes,
  markdown: seriesMarkdown,
};
