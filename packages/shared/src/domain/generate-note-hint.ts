// What Send will probably do with a note on a generated video (Generated videos, GN8), as a HINT
// for the Review dialog, the phone's Review and the quick-fix router's guard (GN6).
//
// A note on a generated job is one of three things:
//   clip   what is IN a clip (a hand, a face, the logo, a bent pole, the water): one new take of
//          that clip, from Higgsfield, which costs about what the kept take cost
//   voice  how the voice says a line (stress, a pause, louder): that line is made again with
//          ElevenLabs, which costs nothing on Higgsfield
//   edit   anything else (cut, words, timing, music, layout): the edit run changes it, no spend
//
// The sorting here is a few word lists and the clock, so it can be wrong; the REAL sorting is the
// revise run's (the `generate-revise` prompt). The hint exists so the owner sees, before he presses
// Send, which notes will spend money and about how much. Pure: no clock, no network, no files.

import { z } from 'zod';
import { budgetLeftUsd, budgetUsdText, type GenerateState, spendUsdText } from './generate.ts';

// --- the word lists -------------------------------------------------------------------------------

// A word of a list matches from its start (never inside another word), with the endings below, and
// may not run on into more letters: "hands" and "bending" match, "handle" and "faced" do not. An
// entry of two or more words is a phrase ("say it", "to the left"): its spaces match any run of
// spaces, and the same rules hold at its two ends. A word that is common in notes about captions,
// cards and music ("read", "say", "tone", "left", "right") is only listed inside a phrase that makes
// it about the voice or a position (C68). The lists are English and Hebrew; a Hebrew word may carry
// the one-letter prefixes (the, in, to, and, from, that) the language glues on.
const NOT_IN_A_WORD = '(?<![\\p{L}\\p{N}])';
const NOT_CONTINUED = '(?![\\p{L}\\p{N}])';
const ENDINGS = '(?:s|es|ed|ing)?';
const HEBREW_PREFIX = '[והבלכמש]{0,2}';

/**
 * Words that say the picture of a clip is wrong. Whole words, with the common endings, so "hand",
 * "hands" and "bending" count and "handle" does not. Hebrew: hand, fingers, face, logo, crooked,
 * distorted, water, brush, pipe, pole, melts.
 */
export const GENERATE_CLIP_WORDS: readonly string[] = [
  'hand',
  'finger',
  'thumb',
  'face',
  'logo',
  'bent',
  'bend',
  'warp',
  'morph',
  'melt',
  'glitch',
  'glitchy',
  'weird',
  'pole',
  'squeegee',
  'water',
  'lint',
  'brush',
  'hose',
];
export const GENERATE_CLIP_WORDS_HE: readonly string[] = [
  'יד',
  'ידיים',
  'אצבע',
  'אצבעות',
  'פנים',
  'לוגו',
  'עקום',
  'עקומה',
  'מעוות',
  'מעוותת',
  'מים',
  'מברשת',
  'צינור',
  'מוט',
  'נמס',
];

/**
 * Words that say how a voice line sounds. Voice, stress, emphasis, a pause, louder, the narrator,
 * how a word is said or read (as phrases, see above). Hebrew: voice, emphasis, a pause, the narrator,
 * pronunciation, accent.
 */
export const GENERATE_VOICE_WORDS: readonly string[] = [
  'voice',
  'voiceover',
  'stress',
  'emphasis',
  'emphasise',
  'emphasize',
  'louder',
  'quieter',
  'pause',
  'narrator',
  'narration',
  'pronounce',
  'pronunciation',
  // Say, read and tone alone are about captions, cards and the colour grade as often as the voice.
  'say it',
  'say that',
  'say this',
  'he says',
  'she says',
  'they say',
  'he said',
  'she said',
  'he reads',
  'she reads',
  'it reads',
  'the way he',
  'the way she',
  'how he says',
  'how she says',
  'his tone',
  'her tone',
  'tone of voice',
];
export const GENERATE_VOICE_WORDS_HE: readonly string[] = [
  'קול',
  'קולו',
  'הדגש',
  'הדגשה',
  'הפסקה',
  'קריין',
  'הגייה',
  'מבטא',
];

/**
 * Words that say a size, a position or a shape: only the format the note was written on changes.
 * Hebrew: big, small, up, down, right, left, position, crop, centre.
 */
export const GENERATE_LAYOUT_WORDS: readonly string[] = [
  'bigger',
  'larger',
  'smaller',
  'move',
  'lower',
  'higher',
  'to the left',
  'to the right',
  'on the left',
  'on the right',
  'left side',
  'right side',
  'layout',
  'position',
  'crop',
  'centre',
  'center',
];
export const GENERATE_LAYOUT_WORDS_HE: readonly string[] = [
  'גדול',
  'גדולה',
  'קטן',
  'קטנה',
  'למעלה',
  'למטה',
  'ימינה',
  'שמאלה',
  'מיקום',
  'חיתוך',
  'מרכז',
];

function wordsPattern(english: readonly string[], hebrew: readonly string[]): RegExp {
  const latin = `${NOT_IN_A_WORD}(?:${english.map((word) => word.replace(/ +/g, '\\s+')).join('|')})${ENDINGS}${NOT_CONTINUED}`;
  const he = `${NOT_IN_A_WORD}${HEBREW_PREFIX}(?:${hebrew.join('|')})${NOT_CONTINUED}`;
  return new RegExp(`${latin}|${he}`, 'iu');
}

const CLIP_PATTERN = wordsPattern(GENERATE_CLIP_WORDS, GENERATE_CLIP_WORDS_HE);
const VOICE_PATTERN = wordsPattern(GENERATE_VOICE_WORDS, GENERATE_VOICE_WORDS_HE);
const LAYOUT_PATTERN = wordsPattern(GENERATE_LAYOUT_WORDS, GENERATE_LAYOUT_WORDS_HE);

/** Whether the note's words are about what is in a clip. */
export function noteMentionsClip(text: string): boolean {
  return CLIP_PATTERN.test(text);
}

/** A note about the music or a sound effect: "louder music" is not about the voice. */
const SOUND_BED_PATTERN =
  /(?<![\p{L}\p{N}])(?:music|song|soundtrack|sfx|sound effects?|beat|alert)s?(?![\p{L}\p{N}])/iu;

/** The words that are about the voice whatever else the note names. */
const STRONG_VOICE_PATTERN = wordsPattern(
  [
    'voice',
    'voiceover',
    'narrator',
    'narration',
    'stress',
    'emphasis',
    'emphasise',
    'emphasize',
    'pause',
    'pronounce',
    'pronunciation',
  ],
  ['קול', 'קולו', 'הדגש', 'הדגשה', 'הפסקה', 'קריין', 'הגייה', 'מבטא'],
);

/** Whether the note's words are about how the voice sounds. */
export function noteMentionsVoice(text: string): boolean {
  if (!VOICE_PATTERN.test(text)) return false;
  return !SOUND_BED_PATTERN.test(text) || STRONG_VOICE_PATTERN.test(text);
}

/** Whether the note's words are about a size, a position or a shape. */
export function noteMentionsLayout(text: string): boolean {
  return LAYOUT_PATTERN.test(text);
}

// --- the plan the hint reads ---------------------------------------------------------------------

const secondsSchema = z.number().nonnegative();

/**
 * What the hint needs of a generated job, as `GET /api/jobs/:id/generate/review-plan` sends it: the
 * clips that are in the cut (from shots.json) with the stretches of the cut they fill and what the
 * kept take cost, and the voice lines (from voice-words.json) with the stretch each is spoken over.
 */
export const generateNotePlanSchema = z.object({
  clips: z.array(
    z.object({
      id: z.string().min(1),
      /** What the kept take cost: about what a new take of the clip costs. */
      usd: z.number().nonnegative(),
      /** What the clip shows, in one plain sentence (the job sheet names the clip below the bar with it). GN9. */
      shows: z.string().optional(),
      /** The kept take failed its check and no better one could be paid for (the job sheet says so). GN9. */
      belowBar: z.boolean().optional(),
      windows: z.array(z.object({ startSec: secondsSchema, endSec: secondsSchema })),
    }),
  ),
  lines: z.array(
    z.object({ id: z.string().min(1), startSec: secondsSchema, endSec: secondsSchema }),
  ),
});
export type GenerateNotePlan = z.infer<typeof generateNotePlanSchema>;

// --- the hint ------------------------------------------------------------------------------------

export const NOTE_HINT_KINDS = ['clip', 'voice', 'edit'] as const;
export type NoteHintKind = (typeof NOTE_HINT_KINDS)[number];

/** What Send will probably do with one note. */
export interface GenerateNoteHint {
  kind: NoteHintKind;
  /** `clip`: the clip at the note's moment ("B"). */
  clipId?: string;
  /** `voice`: the voice line spoken at the note's moment ("L2"). */
  lineId?: string;
  /** `clip`: about what a new take costs; `voice`: 0 (ElevenLabs, nothing on Higgsfield); `edit`: left out. */
  costUsd?: number;
  /**
   * `both`: the change is made in every format. `own`: it is about size or position, so only in the
   * format the note was written on (it matters only on a job with two formats).
   */
  formatScope: 'both' | 'own';
}

/** The clip on screen at `sec`, or null (the $97 card and the end card are not clips). */
function clipAt(plan: GenerateNotePlan, sec: number): GenerateNotePlan['clips'][number] | null {
  return (
    plan.clips.find((clip) =>
      clip.windows.some((window) => sec >= window.startSec && sec < window.endSec),
    ) ?? null
  );
}

/** The voice line spoken at `sec`: the last that began by then, else the first. */
function lineAt(plan: GenerateNotePlan, sec: number): GenerateNotePlan['lines'][number] | null {
  let found: GenerateNotePlan['lines'][number] | null = null;
  for (const line of plan.lines) {
    if (line.startSec <= sec && (found === null || line.startSec >= found.startSec)) found = line;
  }
  return found ?? plan.lines[0] ?? null;
}

/**
 * What Send will probably do with a note written at `atMs` of the cut: a clip word with a clip on
 * screen is a new take of that clip (the first rule, as a hand in a clip is the likeliest note); a
 * voice word is that voice line made again; a size or position word is an edit that is only about
 * the format the note was written on; anything else is an edit in every format.
 */
export function generateNoteHint(
  text: string,
  atMs: number,
  plan: GenerateNotePlan,
): GenerateNoteHint {
  const sec = Math.max(0, atMs) / 1000;
  if (noteMentionsClip(text)) {
    const clip = clipAt(plan, sec);
    if (clip !== null) {
      return { kind: 'clip', clipId: clip.id, costUsd: clip.usd, formatScope: 'both' };
    }
  }
  if (noteMentionsVoice(text)) {
    const line = lineAt(plan, sec);
    return {
      kind: 'voice',
      ...(line === null ? {} : { lineId: line.id }),
      costUsd: 0,
      formatScope: 'both',
    };
  }
  return { kind: 'edit', formatScope: noteMentionsLayout(text) ? 'own' : 'both' };
}

/** A hint for a job that is not generated: only whether a layout word keeps the change to one format. */
export function formatScopeOf(text: string): 'both' | 'own' {
  return noteMentionsLayout(text) ? 'own' : 'both';
}

/** What the new takes of these hints cost: one take of each clip, however many notes name it. */
export function newTakesCostUsd(
  hints: readonly Pick<GenerateNoteHint, 'kind' | 'clipId' | 'costUsd'>[],
): number {
  const byClip = new Map<string, number>();
  for (const hint of hints) {
    if (hint.kind !== 'clip' || hint.clipId === undefined) continue;
    byClip.set(hint.clipId, Math.max(byClip.get(hint.clipId) ?? 0, hint.costUsd ?? 0));
  }
  let total = 0;
  for (const usd of byClip.values()) total += usd;
  return Math.round(total * 100) / 100;
}

// --- the words -----------------------------------------------------------------------------------

/** Which way a hint reads: amber for a spend, blue for the voice, grey for an edit. */
export type NoteHintTone = 'amber' | 'blue' | 'muted';

export interface NoteHintLine {
  tone: NoteHintTone;
  text: string;
}

export interface NoteHintWords {
  /**
   * The job's formats are two or more, so a line says where the change lands. `ownLabel` is the
   * label of the format the note was written on ("1:1"), for an edit that is only about it.
   */
  formats?: { ownLabel: string };
  /**
   * `phone`: the line under a note on the phone (board GNPhone) ends with what is left of the
   * budget instead of the formats, since the phone has no footer line for it.
   */
  where?: 'mac' | 'phone';
  /** The budget and what is left of it, for the phone's line. */
  state?: Pick<GenerateState, 'spendUsd' | 'budgetUsd'>;
}

/** "L2" is "2". */
function lineNumber(lineId: string | undefined): string {
  return lineId === undefined ? '' : lineId.replace(/^L/, '');
}

/**
 * The line under a note on a generated job (boards GNReview and GNPhone):
 * "New take of clip B on Send · about $0.51 · both formats" (amber),
 * "Remakes voice line 2 on Send · ElevenLabs, nothing spent on Higgsfield · both formats" (blue),
 * "Edit change · both formats" or "Edit change · 1:1 only" (grey).
 * Without two formats the closing part ("· both formats") is left out.
 */
export function noteHintLine(hint: GenerateNoteHint, words: NoteHintWords = {}): NoteHintLine {
  const both = words.formats === undefined ? '' : ' · both formats';
  if (hint.kind === 'clip') {
    const clip = hint.clipId === undefined ? 'a clip' : `clip ${hint.clipId}`;
    const take = `New take of ${clip} on Send · about ${spendUsdText(hint.costUsd ?? 0)}`;
    if (words.where === 'phone' && words.state !== undefined) {
      const left = `${budgetUsdText(budgetLeftUsd(words.state))} left of the ${budgetUsdText(words.state.budgetUsd)}`;
      return { tone: 'amber', text: `${take} · ${left}` };
    }
    return { tone: 'amber', text: `${take}${both}` };
  }
  if (hint.kind === 'voice') {
    const line = lineNumber(hint.lineId);
    return {
      tone: 'blue',
      text: `Remakes voice line${line === '' ? '' : ` ${line}`} on Send · ElevenLabs, nothing spent on Higgsfield${both}`,
    };
  }
  const where =
    words.formats === undefined
      ? ''
      : hint.formatScope === 'own'
        ? ` · ${words.formats.ownLabel} only`
        : ' · both formats';
  return { tone: 'muted', text: `Edit change${where}` };
}

/**
 * The footer's sentence about the money (board GNReview), after "3 notes.":
 * "New takes use about $0.51 of the $0.67 left of the $3.",
 * "New takes need about $1.20, more than the $0.67 left of the $3: the worst one goes first.", or,
 * with no new take, "No new takes, so nothing spent on Higgsfield."
 */
export function newTakesSentence(
  takesUsd: number,
  state: Pick<GenerateState, 'spendUsd' | 'budgetUsd'>,
): string {
  if (takesUsd <= 0) return 'No new takes, so nothing spent on Higgsfield.';
  const left = budgetLeftUsd(state);
  const of = `${budgetUsdText(left)} left of the ${budgetUsdText(state.budgetUsd)}`;
  return takesUsd > left
    ? `New takes need about ${spendUsdText(takesUsd)}, more than the ${of}: the worst one goes first.`
    : `New takes use about ${spendUsdText(takesUsd)} of the ${of}.`;
}
