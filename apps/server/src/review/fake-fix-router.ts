// The fake router (quick fixes, QF1): sorts a note by keywords, in English and in Hebrew, with no
// model and no process. The engine uses it wherever the fake runner is chosen (the e2e engine, the
// dev seeds), as it uses the fake transcriber. The rules are the design board's classify() (the
// canvas page "Quick fixes", board "Review"), in the same order: a later rule only sees the notes
// the earlier ones left. It answers after 300 ms, so a spec can see the note "being read".

import type { Job, NoteRoute, ReviewNote } from '@studio/shared';
import { type NoteRouter, UNREADABLE_ROUTE } from './fix-router.js';

/** How long the fake router takes to answer. */
export const FAKE_ROUTE_DELAY_MS = 300;

const FULL =
  /(pace|pacing|drags|too slow|beat|shorter|longer|length|stabili|grading|structure|whole video|all the shots|vertical|portrait|קצב)/;
const MUSIC = /(music|מוזיק|song|sound)/;
const LOOK = /(@luts|\blut\b|exposure|too bright|too dark|grade)/;
const CUT = /(shot|שוט|clip|swap|trim|drone|opening|\bpan\b|\bcut\b|\bcuts\b)/;
const QUICK =
  /(font|גופן|caption|subtitle|כתובי|title|כותרת|text|טקסט|colou?r|צבע|yellow|צהוב|bigger|smaller|larger|size|higher|lower|position|logo|לוגו|bold|thinner|weight|word|typo|sign|שלט)/;

/** What a quick note asks for, in the words of the board's steps; the first rule that fits. */
const QUICK_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\btitle|כותרת)/, 'Changing the title'], // not "subtitle"
  [/(logo|לוגו)/, 'Changing the logo'],
  [/(heebo|font|גופן|bold|thinner|weight)/, 'Changing the caption font'],
  [/(yellow|צהוב|colou?r|צבע)/, 'Changing the caption colour'],
  [/(bigger|larger|smaller|size|גדול|קטן)/, 'Changing the caption size'],
  [/(higher|lower|position|למעלה)/, 'Moving the captions'],
  [/(sign|שלט)/, 'Changing the sign'],
  [/./s, "Changing the caption's words"],
];

/** The route the keyword rules give a note's text. */
export function classifyNote(text: string): NoteRoute {
  const t = text.toLowerCase();
  if (FULL.test(t))
    return { tier: 'full', kind: 'Changing the pacing', why: 'it changes the whole video' };
  if (MUSIC.test(t))
    return { tier: 'revise', kind: 'Changing the music', why: 'it changes the music' };
  if (LOOK.test(t)) {
    return { tier: 'revise', kind: 'Changing the look', why: 'it changes the look of the footage' };
  }
  if (CUT.test(t)) return { tier: 'revise', kind: 'Changing the cut', why: 'it changes the cut' };
  if (QUICK.test(t)) {
    const kind = QUICK_KINDS.find(([rule]) => rule.test(t))?.[1] ?? 'Changing the text';
    return { tier: 'quick', kind, why: '' };
  }
  return { tier: 'revise', kind: 'Changing the edit', why: 'it may change the cut' };
}

export interface FakeNoteRouterOptions {
  /** Default {@link FAKE_ROUTE_DELAY_MS}. */
  delayMs?: number;
}

export class FakeNoteRouter implements NoteRouter {
  private readonly delayMs: number;

  constructor(options: FakeNoteRouterOptions = {}) {
    this.delayMs = options.delayMs ?? FAKE_ROUTE_DELAY_MS;
  }

  async route(_job: Job, note: ReviewNote, signal?: AbortSignal): Promise<NoteRoute> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, this.delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const text = note.text?.trim() ?? '';
    return text === '' ? UNREADABLE_ROUTE : classifyNote(text);
  }
}
