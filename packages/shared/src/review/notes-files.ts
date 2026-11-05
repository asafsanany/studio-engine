// Renders review notes as the text of the Markdown files the engine writes when the owner sends a
// round: the round file edit/review/round-N.md, which the revise run reads, and the notes file
// "Review notes – <job> – round N.md", which goes into the client's _Style folder (style notes) or
// into the series folder (series notes). The two notes files differ only in their intro.
//
// Pure: the same notes always give the same text, with no clock, no locale lookups and no file
// access. The rules are §3 ("The round file") and §7 ("Add to style") of the Phase 3 architecture
// page. The Send step (W5) and the Add to style step (W7) call these functions and write the result.

/** What the round file and the style-notes file need from a review note. W5's ReviewNote satisfies it as it is. */
export interface ReviewNoteForFile {
  /** Where the note is pinned on the preview's timeline, in seconds. */
  readonly atSec: number;
  readonly kind: 'text' | 'voice';
  /** A text note's body, or a voice note's transcript. */
  readonly text?: string | null;
  /** A voice note's audio file, relative to the job folder (edit/review/voice/<id>.webm). */
  readonly audioFile?: string | null;
  /** Null for a text note. */
  readonly transcriptStatus?: 'pending' | 'done' | 'failed' | null;
  /**
   * The format of the preview the note was written on (Generated videos): the id of an extra
   * format ("1x1"), `null` or left out for the main one. Only the round file of a job with two
   * formats prints it (`RoundFileInput.formats`).
   */
  readonly format?: string | null;
}

/** A note that was fixed in Review (quick fixes, QF4): what it asked for and what the fix said it did. */
export interface FixedNoteForFile extends ReviewNoteForFile {
  /** The fix's reply to the owner ("The captions are Heebo Bold now."); `null` or blank when it has none. */
  readonly said?: string | null;
}

export interface RoundFileInput {
  /** Job.name, as it is. */
  readonly job: string;
  /** Job.client, as it is. */
  readonly client: string;
  /** The round being sent: job.round + 1. */
  readonly round: number;
  /** The notes that wait for this round's run (every unsent note without a fix), in any order. */
  readonly notes: readonly ReviewNoteForFile[];
  /**
   * The notes already fixed in Review (QF4), in any order. They come after the others under their
   * own heading; left out or empty, the file is what it was before quick fixes, byte for byte.
   */
  readonly fixed?: readonly FixedNoteForFile[];
  /**
   * The job's formats, main first (`Job.formats`), only for a job with two or more. Then every
   * line says which preview its note was written on, "- 0:07.0 (on 1:1) — …", so the revise run
   * knows which format a note about size or position means. Left out or fewer than two, the file
   * is what it was before formats, byte for byte.
   */
  readonly formats?: readonly { readonly id: string; readonly label: string }[];
}

export interface StyleNotesFileInput {
  /** Job.name, as it is. */
  readonly job: string;
  /** The round that was just sent (the same N as round-N.md). */
  readonly round: number;
  /** Only the notes marked Add to style. This function does not filter on that. */
  readonly notes: readonly ReviewNoteForFile[];
}

export interface SeriesNotesFileInput extends StyleNotesFileInput {
  /** The series' name, as it is: the name of its folder under _Series. */
  readonly series: string;
}

/** The longest style-notes file name, in UTF-8 bytes. APFS allows 255; the other 15 are left for W7's " (n)". */
export const STYLE_NOTES_FILE_NAME_MAX_BYTES = 240;

const ROUND_FILE_INTRO =
  "The owner watched the preview (edit/preview/) and wrote these notes. Each time is a moment on the preview's timeline.";

/** Under the intro of the round file of a job with two formats: what "(on 1:1)" after a time means. */
const FORMATS_INTRO =
  'This job has more than one format. After its time, each note says which format\'s preview they were watching when they wrote it, for example "(on 1:1)".';

/** The heading of the round file's second list: the notes a quick fix already did (QF4). */
export const FIXED_NOTES_HEADING = 'Already changed in Review (keep these)';

const FIXED_NOTES_INTRO =
  "The owner's other notes below were already done in the live preview (edit/preview/) while they were reviewing. Keep each of them exactly as it is: do not undo, redo or move them. They are listed so you know what the preview holds.";

const STYLE_NOTES_INTRO =
  'The owner wrote these while reviewing this job and asked for them to become part of this client\'s style. Turn each into a general rule for the client\'s future videos, in plain English (for example "the title goes too fast" becomes "Titles stay on screen about a second longer"). Keep any on-screen text word for word. Ignore the times; they only place the note in this job.';

/** The intro of a series-notes file. It names the series, so a rule stays with the series and not with the client. */
function seriesNotesIntro(series: string): string {
  return `The owner wrote these while reviewing this episode and asked for them to become part of the series “${series}”. Turn each into a rule for the series' next episodes, in plain English (for example "the title goes too fast" becomes "Titles stay on screen about a second longer"). Keep any on-screen text word for word. Ignore the times; they only place the note in this episode. A rule is for this series only, not for the client's other videos.`;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A note time as m:ss.s, for example 0:02.4. Minutes keep counting past 59:59.9: there are no hours. */
export function formatNoteTime(sec: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  // Whole tenths, half up. toFixed(6) first, so float noise can't pull a half down (1.45 * 10 is 14.499999999999998).
  const tenths = Math.round(Number((safe * 10).toFixed(6)));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

/**
 * The text of the round file: a header, an intro and one line per note in time order. Notes already
 * fixed in Review (`input.fixed`) follow under {@link FIXED_NOTES_HEADING}: each with its time, its
 * words and, indented under it, what the fix said it did.
 */
export function renderRoundFile(input: RoundFileInput): string {
  const blocks = [
    `# Review notes, round ${input.round}: ${input.job} (${input.client})`,
    ROUND_FILE_INTRO,
  ];
  const stamp = formatStamp(input.formats);
  if (input.formats !== undefined && input.formats.length >= 2) blocks.push(FORMATS_INTRO);
  const lines = noteLines(input.notes, roundFileBody, undefined, stamp);
  if (lines.length > 0) blocks.push(lines.join('\n'));
  const fixed = noteLines(input.fixed ?? [], roundFileBody, fixedSuffix, stamp);
  if (fixed.length > 0) {
    blocks.push(`## ${FIXED_NOTES_HEADING}`, FIXED_NOTES_INTRO, fixed.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * What a round file prints after a note's time for the format it was written on: "(on 1:1)". A note
 * without a format was written on the main one. Nothing for a job with fewer than two formats, and
 * for a format the job no longer has.
 */
function formatStamp(
  formats: RoundFileInput['formats'],
): (note: ReviewNoteForFile) => string | null {
  if (formats === undefined || formats.length < 2) return () => null;
  const [main] = formats;
  return (note) => {
    const id = note.format ?? main?.id;
    const found = formats.find((format) => format.id === id);
    return found === undefined ? null : `(on ${found.label})`;
  };
}

/** The name of the style-notes file, never longer than STYLE_NOTES_FILE_NAME_MAX_BYTES in UTF-8. */
export function styleNotesFileName(job: string, round: number): string {
  const name = (part: string): string => `Review notes – ${part} – round ${round}.md`;
  // The same rule as exportFileNamePart in the server's finalize.ts (shared can't import the server).
  const part = job.normalize('NFC').replace(/[/:\0]/g, '-');
  if (utf8Length(name(part)) <= STYLE_NOTES_FILE_NAME_MAX_BYTES) return name(part);
  const kept = Array.from(graphemes.segment(part), ({ segment }) => segment);
  while (
    kept.length > 0 &&
    utf8Length(name(`${kept.join('').trimEnd()}…`)) > STYLE_NOTES_FILE_NAME_MAX_BYTES
  ) {
    kept.pop();
  }
  return name(`${kept.join('').trimEnd()}…`);
}

/** The text of the style-notes file, or null when no note has anything to turn into a rule. */
export function renderStyleNotesFile(input: StyleNotesFileInput): string | null {
  return renderRulesFile(input, STYLE_NOTES_INTRO);
}

/** The text of the series-notes file, or null when no note has anything to turn into a rule. */
export function renderSeriesNotesFile(input: SeriesNotesFileInput): string | null {
  return renderRulesFile(input, seriesNotesIntro(input.series));
}

/** A header, the intro and one line per note that can become a rule; null when no note can. */
function renderRulesFile(input: StyleNotesFileInput, intro: string): string | null {
  const lines = noteLines(input.notes, styleNotesBody);
  if (lines.length === 0) return null;
  const header = `# Review notes from ${input.job} (round ${input.round})`;
  return `${[header, intro, lines.join('\n')].join('\n\n')}\n`;
}

/** One list item per note that has a body, in time order. The input array is not changed. */
function noteLines<N extends ReviewNoteForFile>(
  notes: readonly N[],
  bodyOf: (note: N) => string | null,
  afterOf: (note: N) => string | null = () => null,
  stampOf: (note: N) => string | null = () => null,
): string[] {
  const lines: string[] = [];
  // Array.prototype.sort is stable, so notes with the same time keep their input order.
  for (const note of [...notes].sort((a, b) => sortTime(a.atSec) - sortTime(b.atSec))) {
    const body = bodyOf(note);
    if (body === null) continue;
    const after = afterOf(note);
    lines.push(listItem(note.atSec, body, after, stampOf(note)));
  }
  return lines;
}

/** What a fixed note's item says after its words: the fix's reply, or nothing when it has none. */
function fixedSuffix(note: FixedNoteForFile): string | null {
  const said = (note.said ?? '').trim();
  return said === '' ? null : `Changed: ${said}`;
}

/** A time that isn't a usable position sorts (and prints) as 0. */
function sortTime(atSec: number): number {
  return Number.isFinite(atSec) && atSec > 0 ? atSec : 0;
}

/** The transcript of a voice note, trimmed; null when it has none (not done, or nothing in it). */
function transcriptOf(note: ReviewNoteForFile): string | null {
  if (note.kind !== 'voice' || note.transcriptStatus !== 'done') return null;
  return (note.text ?? '').trim() || null;
}

/** What the round file says for a note, or null when the note gets no line. */
function roundFileBody(note: ReviewNoteForFile): string | null {
  if (note.kind !== 'voice') return (note.text ?? '').trim() || null;
  const label = note.audioFile ? `voice note (${note.audioFile})` : 'voice note';
  const transcript = transcriptOf(note);
  return transcript === null ? `${label}: not transcribed` : `${label}: "${transcript}"`;
}

/** What the style-notes file says for a note, or null when the note gets no line. */
function styleNotesBody(note: ReviewNoteForFile): string | null {
  if (note.kind !== 'voice') return (note.text ?? '').trim() || null;
  return transcriptOf(note);
}

/** The lines of a body: \r\n and \r end a line, trailing spaces go, and a run of blank lines becomes one. */
function bodyLines(body: string): string[] {
  const lines: string[] = [];
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line === '' && lines.at(-1) === '') continue;
    lines.push(line);
  }
  return lines;
}

/**
 * "- m:ss.s — first line" ("- m:ss.s (on 1:1) — first line" with a `stamp`), then every later line
 * indented by two spaces (blank lines stay empty), then `after` (when given) indented the same way,
 * line by line.
 */
function listItem(
  atSec: number,
  body: string,
  after: string | null = null,
  stamp: string | null = null,
): string {
  const [first = '', ...rest] = bodyLines(body);
  const more = [...rest, ...(after === null ? [] : bodyLines(after))].map((line) =>
    line === '' ? '' : `  ${line}`,
  );
  const time = stamp === null ? formatNoteTime(atSec) : `${formatNoteTime(atSec)} ${stamp}`;
  return [`- ${time} — ${first}`, ...more].join('\n');
}

/** The length of a string in UTF-8 bytes. The package has no TextEncoder or Buffer types, so it is counted by hand. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
