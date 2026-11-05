// The Brief step (B4; Phase 1 architecture page §2): before every edit run (start, resume and
// retry), the client's instructions in the job folder and the owner's note become edit/brief.json and
// edit/brief.md, and the edit run reads brief.md first.
//
//   0. Style (Phase 2, C5): if the job has no edit/style/ yet and its client's _Style/style.md
//      exists, _Style is copied into edit/style/ (without history, as an APFS clone where it can).
//      Retry and Resume find the copy and keep it, so a job keeps the style it started with. The
//      brief.md of every path below ends with a "Client style" section made from that copy; the
//      Brief run itself doesn't read it, and the fingerprint doesn't cover it. An episode's series
//      (`_Series/<name>`) is frozen the same way into edit/series/, and the "Series" section of
//      brief.md, before the style's, is made from that copy (Series plan §4, CVP-179).
//   1. List the job folder the way the scanner counts it and take its fingerprint: sha1 over the
//      sorted lines `relPath\tsize\tmtimeMs`, then the note.
//      With the Generate switch on (Generated videos, GN4), every `.zip` in the folder is unpacked
//      first into `edit/brief/unzipped/<zip name>/` (brief-unzip.ts: path traversal, absolute
//      paths, links, __MACOSX and .DS_Store, 200 MB and 500 files). The unpacked files join the list,
//      each marked with the zip it came from, and take the CRC-32 of their content (from the zip)
//      into the fingerprint in place of a modified time, so a zip whose content changed gives a new
//      brief even when its size and date did not. A zip that is refused fails the step with a plain
//      "Brief stopped: the zip “…” …" line. With the switch off none of this happens.
//      With the Songs switch on, the pictures attached to the note (edit/brief/from-you/, SG5) are
//      listed and fingerprinted like job files, marked `attached`: the Brief run reads them
//      (a screenshot of a reel names the song), and adding or removing one gives a new
//      fingerprint, so Retry and Resume run the Brief again. With the switch off the folder is not
//      looked at, and everything here is as it was.
//   2. Reuse: edit/brief.json parses with the full schema and has that fingerprint -> nothing to
//      do but render brief.md again.
//   3. Skip: every file is a video or of a type the engine does not know (a .fcpxml, a .prproj)
//      and there is no note -> the engine writes the "no instructions" brief itself, without a
//      run; the unknown files are in it with the role `ignore`. With the Generate switch on a zip
//      is never skipped (it can hold the client's instructions), and neither is a video under
//      reference/ (style to match, never footage): a folder with a references zip and no footage
//      is a job to brief, not an empty one.
//   4. Otherwise the writer runs (the Claude Brief run, claude-brief.ts, or the fake one,
//      fake-brief.ts) and leaves a draft in edit/brief.json. It is parsed with the draft schema.
//      If the owner's note states the canvas the draft carries, `canvas` is taken out of `assumed`.
//      An episode whose series copy is there is named to the run (`BriefWrite.series`), so its
//      brief does not say "video-use defaults" above the Series section that follows (CVP-255).
//      With the Generate switch on, the engine also puts right what a run must not decide: every
//      zip has the role `ignore` (its files are listed on their own), `canvas` is the first of
//      `formats` when the run left it null, and with the switch off the four Generated-video keys
//      (`production`, `voiceover`, `formats`, `budgetUsd`) are null whatever the run wrote.
//   4b. Draft & chat (DR4, `draft`): a job whose folder has footage (a video or a sound outside
//      reference/, not from a zip or attached to the note) has no Claude Brief run. The engine
//      writes the placeholder brief instead (`draftPendingBrief`: the summary says it is not read
//      yet, each file has a first guess at its role) and the Draft reads the instructions itself and
//      writes edit/brief.json over it. After the Draft the worker calls `adopt`: a brief the Draft
//      wrote that matches the draft schema gets `schema: 1` and the fingerprint and its brief.md.
//      A job with no footage (a generated video) still has its Brief run, before Generate.
//   5. The engine adds `schema: 1` and the fingerprint, rewrites brief.json and renders brief.md.
//      Each time, the shared fonts in `<inbox>/_Fonts` are copied into edit/fonts/ again first
//      (CVP-201, shared-fonts.ts), and brief.md ends with a "Fonts" section that lists them.
//      While the graphicsInEdits switch is on (the step is given the library's rows), the same
//      goes for the Graphics library (GR8): every live graphic with "Edits can use it" on and a
//      version is copied from `<inbox>/_Graphics/<folder>/versions/vN/` into edit/graphics/<id>/,
//      and brief.md ends with a "Graphics library" section after "Fonts". Off, nothing is copied
//      and brief.md has no such section.
//      The client's shared files in `<inbox>/<Client>/_Shared` (logo, b-roll, footage for many
//      briefs) are listed again each time too, in a "Client shared files" section after "Files";
//      nothing is copied: the edit run copies the ones it uses into edit/shared/ (shared-files.ts).
//      With none there is no section. A job folder with no footage of its own (Generate on) also
//      has them named to the Brief run: when the instructions name clips that are there, the video
//      is an edit of them, not a generated one. They are part of its fingerprint, so a clip added
//      to `_Shared` after a brief that said "generate" gives a new brief on the next Retry.
//
// Only step 4 is "the Brief run": only then does the job show step 1 with "reading N files" (then
// "voice notes n" as transcripts appear in edit/brief/transcripts/), and only then is step 1
// timed. Any failure is a failure at step 1 with a "Brief stopped: …" line.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import {
  type Brief,
  type BriefDraft,
  type BriefGraphic,
  type BriefSeries,
  type BriefStyle,
  briefDraftSchema,
  briefSchema,
  DRAFT_PENDING_BRIEF_SUMMARY,
  draftPendingBrief,
  firstBriefIssue,
  type Job,
  noInstructionsBrief,
  renderBriefMd,
  type StepId,
  seriesNameFrom,
} from '@studio/shared';
import {
  SERIES_FILE_NAME,
  SERIES_NEW_FILE_NAME,
  STYLE_FILE_NAME,
  seriesDirFor,
  seriesFileFor,
  sharedDirFor,
  styleDirFor,
  styleFileFor,
} from '../clients/paths.js';
import type { GraphicRepository, SeriesRepository, StoredGraphic } from '../db/index.js';
import { graphicDir, graphicVersionDir } from '../graphics/graphic-folders.js';
import { classifyFile, isReferencePath } from '../inbox/classify.js';
import { type JobFile, listJobFiles } from '../inbox/scan.js';
import { isZipName, UnzipError, unpackJobArchives } from './brief-unzip.js';
import { errorText, type RunnerLogger, SILENT_LOGGER } from './claude-process.js';
import { listNoteAttachments, noteAttachmentRelPath } from './note-attachments.js';
import type { BriefPromptSeries } from './prompts.js';
import { listSharedFiles } from './shared-files.js';
import { copySharedFonts, FONTS_COPY_PATH, listFonts } from './shared-fonts.js';

/** The Brief step's id: the first of the eight. */
export const BRIEF_STEP = 1 satisfies StepId;

/** Where the brief lives, relative to the job folder. */
export const BRIEF_JSON_PATH = 'edit/brief.json';
export const BRIEF_MD_PATH = 'edit/brief.md';
/** Where the Brief run's voice-note transcripts go (never edit/transcripts/: the edit run owns it). */
export const BRIEF_TRANSCRIPTS_PATH = 'edit/brief/transcripts';
/** The job's frozen copy of its client's `_Style`, relative to the job folder. */
export const STYLE_COPY_PATH = 'edit/style';
/** An episode's frozen copy of its series folder, `_Series/<name>`, relative to the job folder. */
export const SERIES_COPY_PATH = 'edit/series';
/** The job's copy of the Graphics library (GR8), relative to the job folder: `edit/graphics/<id>/`. */
export const GRAPHICS_COPY_PATH = 'edit/graphics';
/** What the graphics are copied into, next to their place: renamed to `edit/graphics` once whole. */
const GRAPHICS_STAGING_PATH = 'edit/.graphics-copying';
/** What the copy is made in, next to its place: renamed to `edit/style` once it is whole. */
const STYLE_STAGING_PATH = 'edit/.style-copying';
/** The same for the series copy, renamed to `edit/series`. */
const SERIES_STAGING_PATH = 'edit/.series-copying';
/** The style run's work in progress in `_Style`: not a style yet, so it is not copied. */
const STYLE_IN_PROGRESS = 'style.md.new';

/** The `schema` value the engine writes into brief.json. */
export const BRIEF_SCHEMA_VERSION = 1;

/** How often edit/brief/transcripts/ is looked at while the Brief run goes. */
export const BRIEF_POLL_MS = 1_000;

/** The prefix of every Brief failure the Jobs page shows. */
export const BRIEF_STOPPED = 'Brief stopped:';

/** "Brief stopped: brief.json didn’t match the schema (<first issue>)." */
export function schemaMismatch(issue: string): string {
  return `${BRIEF_STOPPED} brief.json didn’t match the schema (${issue}).`;
}

/** The note as it goes into the fingerprint, the prompt and brief.md: trimmed, `null` when blank. */
export function briefNote(note: string | null | undefined): string | null {
  const text = (note ?? '').trim();
  return text === '' ? null : text;
}

/** A size like 1080x1920 (also "1080 × 1920" or "1080X1920") in free text. */
const SIZE_IN_TEXT = /(?<!\d)(\d{3,4})\s*[x×X]\s*(\d{3,4})(?!\d)/g;

/**
 * P21 (CVP-136): the note states the canvas when it holds the same WxH as the draft's `canvas`.
 * The brief then must not call it assumed (an "(assumed)" canvas is one the edit run may
 * overrule when the footage disagrees), whatever the run wrote in `assumed`.
 */
export function noteStatesCanvas(note: string | null, canvas: string | null): boolean {
  if (note === null || canvas === null) return false;
  return [...note.matchAll(SIZE_IN_TEXT)].some((match) => `${match[1]}x${match[2]}` === canvas);
}

/**
 * sha1 over the sorted lines `relPath\tsize\tmtimeMs` (whole milliseconds) of the files the
 * scanner counts, joined by newlines, then a newline and the note. A changed, added or removed
 * file, or a changed note, gives another fingerprint and so a new brief. A file unpacked from a
 * zip (Generate) carries the CRC-32 of its content as `contentKey` and the line says
 * `crc:<hex>` where the others say the modified time.
 * `shared` is the client's shared files the Brief run was told about (a job folder with no footage,
 * Generate on): they decide whether the video is generated or an edit of clips in `_Shared`, so a
 * file added there or taken out gives a new brief too. Without any the fingerprint is what it was.
 */
export function briefFingerprint(
  files: readonly (Pick<JobFile, 'relPath' | 'size' | 'mtimeMs'> & { contentKey?: string })[],
  note: string | null,
  shared: readonly string[] = [],
): string {
  const lines = files
    .map(
      (file) =>
        // A file unpacked from a zip is told by its content (its CRC-32), not by a modified time.
        `${file.relPath}\t${file.size}\t${file.contentKey === undefined ? Math.trunc(file.mtimeMs) : `crc:${file.contentKey}`}`,
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sharedLines = shared.length === 0 ? '' : `\nshared:\n${shared.join('\n')}`;
  return createHash('sha1')
    .update(`${lines.join('\n')}\n${note ?? ''}${sharedLines}`, 'utf8')
    .digest('hex');
}

/**
 * True for a brief written while Songs was off that never read its song. Without the Songs keys the
 * Brief run put the instructions' "Music: [title] - [artist]" into `music.file`, a name with no file
 * behind it, and left `song` null. The fingerprint (files and note) is the same once Songs is on, so
 * without this the brief would be reused and the song asked for would be dropped again.
 */
export function briefNamesUnreadSong(
  brief: Brief,
  files: readonly Pick<JobFile, 'relPath'>[],
): boolean {
  const music = brief.music;
  if (music === null || music.file === null) return false;
  if (music.song !== null || music.original !== null || music.wantsTrending) return false;
  const named = music.file;
  return !files.some((file) => file.relPath === named || basename(file.relPath) === named);
}

/**
 * A file the Brief is about: one the scanner counts, or (`attached`) a picture the owner attached to the
 * note, which sits in edit/brief/from-you/ and which the run is told they attached themselves.
 */
export interface BriefFile extends JobFile {
  attached?: true;
  /**
   * A file unpacked from a zip of the job folder (Generate, GN4): that zip, relative to the job
   * folder. The prompt lists it as "from <zip>"; its own path is under `edit/brief/unzipped/`.
   */
  fromZip?: string;
  /** The CRC-32 of its content (8 hex digits), from the zip. The fingerprint uses it for `fromZip` files. */
  contentKey?: string;
}

/** The files a Brief is about, and the job's zips among them (Generate; empty with the switch off). */
interface ListedFiles {
  readonly files: BriefFile[];
  readonly zips: readonly string[];
}

/** What the worker gives the Brief step for one run. */
export interface BriefContext {
  /** Aborted when the user cancels the job or the engine shuts down. */
  readonly signal: AbortSignal;
  /**
   * The Brief run is running: show step 1 with this text. Called only while a writer runs, never
   * when the brief is reused or skipped, so the first call is also where step 1's timing starts.
   */
  progress(sub: string): void;
}

/** How the brief came about: written by a run, reused as it was, or skipped (only footage). */
export type BriefSource = 'ran' | 'reused' | 'skipped' | 'pending';

export type BriefOutcome =
  | { ok: true; source: BriefSource; brief: Brief }
  /** Fails the job at step 1 with `error` (unless the run was aborted). */
  | { ok: false; error: string };

/** The Brief step as the worker sees it. */
export interface BriefRun {
  /** Makes sure edit/brief.json and brief.md are there and current. Never rejects. */
  prepare(job: Job, context: BriefContext): Promise<BriefOutcome>;
  /**
   * Draft & chat (DR4): after the Draft, takes in the brief it wrote over the placeholder. Left out,
   * or with the switch off, nothing happens. Never rejects.
   */
  adopt?(job: Job): Promise<BriefAdoption>;
}

/** What `adopt` found: a brief it took in, the placeholder still there, or nothing it could use. */
export type BriefAdoption = 'off' | 'adopted' | 'pending' | 'invalid' | 'missing';

/** One run of a writer. */
export interface BriefWrite {
  /** `<inbox>/<Client>/<Job>`. */
  readonly jobDir: string;
  /** The files the brief is about (the fingerprint's), sorted by `relPath`. */
  readonly files: readonly BriefFile[];
  /** The owner's note, trimmed, or `null`. */
  readonly note: string | null;
  /**
   * An episode whose frozen series gives brief.md a "Series" section: the series' name and the
   * job's episode number. Left out or `null` for any other job (CVP-255).
   */
  readonly series?: BriefPromptSeries | null;
  /**
   * The client's shared files, for a job folder with no footage while the Generate switch is on:
   * the clips its instructions name may be there (`BriefPromptVars.shared`). Left out or empty
   * for any other job.
   */
  readonly shared?: readonly string[];
  readonly signal: AbortSignal;
}

export type BriefWriteOutcome = { ok: true } | { ok: false; error: string };

/** Writes the draft to edit/brief.json: the Claude Brief run, or the fake one. */
export interface BriefWriter {
  /**
   * Resolves once the run is over and nothing of it is left running. `ok` only says the run ended
   * normally; the step then reads and validates edit/brief.json itself. A failure's `error` is the
   * line to show. After an abort, whatever it returns is ignored.
   */
  write(job: Job, run: BriefWrite): Promise<BriefWriteOutcome>;
  /**
   * The fake writer's `.fail-at-brief`: a failure to report before anything else, so it also
   * fails a brief that would be reused or skipped. `null` = no failure.
   */
  injectedFailure?(job: Job, run: Pick<BriefWrite, 'jobDir' | 'signal'>): Promise<string | null>;
}

export interface BriefStepOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** `Config.exportsDir`, left out of the file list like the scanner does. */
  exportsDir?: string;
  writer: BriefWriter;
  logger?: RunnerLogger;
  /** How often transcripts are counted during a run. Default 1 s. */
  pollIntervalMs?: number;
  /** An episode's series, by `job.seriesId`, for its folder's name. Left out, no series is frozen. */
  series?: Pick<SeriesRepository, 'get'>;
  /**
   * The Graphics library's rows (GR8). Given only while the graphicsInEdits switch is on: each
   * edit gets a fresh copy of the graphics in edit/graphics/ and the brief a "Graphics library"
   * section. Left out, nothing is copied and brief.md has no such section.
   */
  graphics?: Pick<GraphicRepository, 'list'>;
  /**
   * The Soundtrack switch (`Config.music`, U21). On, brief.md says whether music was asked for
   * ("Music: asked for, made by the editor" / "Music: not asked for"). Off (the default), the music
   * line only appears when the brief has music in it, and a `music.wanted` a run wrote is dropped,
   * so a brief is what it was before. Songs only run with the music, so `songs` counts as on too.
   */
  music?: boolean;
  /**
   * The Songs switch (`Config.songs`, SG5). On, the pictures attached to the job's note are part of
   * the files the brief is about. Off (the default), they are not looked at.
   */
  songs?: boolean;
  /**
   * The Generate switch (`Config.generate`, Generated videos). On: every zip of the job folder is
   * unpacked into edit/brief/unzipped/ before the Brief run and its files are part of the brief,
   * a zip is never skipped as "only unknown files", and the engine puts right the zip roles and
   * the canvas of a generated brief. Off (the default): none of it, and production, voiceover
   * and budgetUsd of a draft are null (formats stay: any job can ask for a second size).
   */
  generate?: boolean;
  /**
   * The Draft & chat switch (`Config.draftChat`, DR4). On: a job with footage gets the placeholder
   * brief instead of the Brief run, and `adopt` takes in the one the Draft writes. Off (the
   * default): every brief is made as before.
   */
  draft?: boolean;
}

/**
 * Footage, as the Draft sees it: a video or a sound of the job's own, not a reference. A folder with
 * none may be an edit of clips in the client's _Shared, so the Brief run is told what is there.
 */
function isDraftFootage(file: BriefFile): boolean {
  return (
    (file.kind === 'video' || file.kind === 'audio') &&
    !isReferencePath(file.relPath) &&
    file.fromZip === undefined &&
    file.attached !== true
  );
}

const STOPPED: { ok: false; error: string } = {
  ok: false,
  error: `${BRIEF_STOPPED} the brief was stopped.`,
};

/** Writes a file in one move, so a reader never sees half of it. */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether anything is at `path`, a broken link or a file as well as a folder. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The job's frozen style for brief.md: edit/style/style.md and the names at the top of
 * edit/style/ (a folder's with a trailing "/"; the renderer picks the ones it lists). `null` when
 * the job has no style.md. Dot files are left out: `.DS_Store` is not one of the style's files.
 */
async function readFrozenStyle(jobDir: string): Promise<BriefStyle | null> {
  const dir = join(jobDir, STYLE_COPY_PATH);
  let markdown: string;
  try {
    markdown = await readFile(join(dir, STYLE_FILE_NAME), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  return { markdown, files };
}

/**
 * An episode's frozen series for brief.md: edit/series/series.md, with the series' name and the
 * job's episode number. `null` when the job has no series.md there, as for any job outside a
 * series.
 */
async function readFrozenSeries(
  jobDir: string,
  name: string,
  episode: number | null,
): Promise<BriefSeries | null> {
  try {
    const markdown = await readFile(join(jobDir, SERIES_COPY_PATH, SERIES_FILE_NAME), 'utf8');
    return { name, episode, markdown };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Reads edit/brief.json as JSON. `missing` when there is none. */
async function readBriefJson(
  jobDir: string,
): Promise<{ ok: true; value: unknown } | { ok: false; issue: string }> {
  let text: string;
  try {
    text = await readFile(join(jobDir, BRIEF_JSON_PATH), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, issue: 'no edit/brief.json was written' };
    }
    return { ok: false, issue: `edit/brief.json could not be read: ${errorText(err)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, issue: `not valid JSON: ${errorText(err)}` };
  }
}

/** The finished brief already in edit/brief.json, or `null` when there is none that parses. */
async function readFinishedBrief(jobDir: string): Promise<Brief | null> {
  const json = await readBriefJson(jobDir);
  if (!json.ok) return null;
  const parsed = briefSchema.safeParse(json.value);
  return parsed.success ? parsed.data : null;
}

/** The step: see the top of the file. */
export class BriefStep implements BriefRun {
  private readonly inboxPath: string;
  private readonly exportsDir: string | undefined;
  /** The Claude or the fake Brief run. */
  readonly writer: BriefWriter;
  private readonly logger: RunnerLogger;
  private readonly pollIntervalMs: number;
  private readonly series: Pick<SeriesRepository, 'get'> | undefined;
  private readonly graphics: Pick<GraphicRepository, 'list'> | undefined;
  private readonly songs: boolean;
  private readonly music: boolean;
  private readonly generate: boolean;
  private readonly draft: boolean;

  constructor(options: BriefStepOptions) {
    this.inboxPath = options.inboxPath;
    this.exportsDir = options.exportsDir;
    this.writer = options.writer;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.pollIntervalMs = options.pollIntervalMs ?? BRIEF_POLL_MS;
    this.series = options.series;
    this.graphics = options.graphics;
    this.songs = options.songs === true;
    this.music = options.music === true || this.songs;
    this.generate = options.generate === true;
    this.draft = options.draft === true;
  }

  async adopt(job: Job): Promise<BriefAdoption> {
    if (!this.draft) return 'off';
    const jobDir = join(this.inboxPath, job.relPath);
    try {
      const json = await readBriefJson(jobDir);
      if (!json.ok) return 'missing';
      const checked = briefDraftSchema.safeParse(json.value);
      if (!checked.success) {
        this.logger.warn(
          { jobId: job.id, issue: firstBriefIssue(checked.error) },
          'brief: the Draft’s brief.json does not match the schema; it is left as it is',
        );
        return 'invalid';
      }
      if (checked.data.summary === DRAFT_PENDING_BRIEF_SUMMARY) return 'pending';
      const note = briefNote(job.note);
      const { files } = await this.briefFiles(jobDir);
      const brief: Brief = {
        schema: BRIEF_SCHEMA_VERSION,
        fingerprint: briefFingerprint(files, note),
        ...checked.data,
      };
      await this.save(job, jobDir, brief, note);
      this.logger.info({ jobId: job.id }, 'brief: the Draft’s brief is taken in');
      return 'adopted';
    } catch (err) {
      this.logger.warn({ jobId: job.id, err }, 'brief: the Draft’s brief could not be taken in');
      return 'invalid';
    }
  }

  async prepare(job: Job, context: BriefContext): Promise<BriefOutcome> {
    try {
      const outcome = await this.run(job, context);
      if (!outcome.ok && !context.signal.aborted) {
        this.logger.warn({ jobId: job.id, error: outcome.error }, 'brief failed');
      }
      return outcome;
    } catch (err) {
      if (context.signal.aborted) return STOPPED;
      this.logger.error({ jobId: job.id, err }, 'brief broke');
      return { ok: false, error: `${BRIEF_STOPPED} ${errorText(err)}` };
    }
  }

  private async run(job: Job, context: BriefContext): Promise<BriefOutcome> {
    const { signal } = context;
    if (signal.aborted) return STOPPED;
    const jobDir = join(this.inboxPath, job.relPath);
    if (!(await isFolder(jobDir))) {
      return { ok: false, error: `${BRIEF_STOPPED} the job folder is missing: ${job.relPath}` };
    }

    // Before anything can fail, so a job that fails here or later has its style when it is retried.
    try {
      await this.freezeStyle(job, jobDir);
    } catch (err) {
      if (signal.aborted) return STOPPED;
      this.logger.warn({ jobId: job.id, err }, 'brief: the client’s style could not be copied');
      return {
        ok: false,
        error: `${BRIEF_STOPPED} the client’s style couldn’t be copied (${errorText(err)}).`,
      };
    }
    try {
      await this.freezeSeries(job, jobDir);
    } catch (err) {
      if (signal.aborted) return STOPPED;
      this.logger.warn({ jobId: job.id, err }, 'brief: the series could not be copied');
      return {
        ok: false,
        error: `${BRIEF_STOPPED} the series couldn’t be copied (${errorText(err)}).`,
      };
    }

    const injected = await this.writer.injectedFailure?.(job, { jobDir, signal });
    if (signal.aborted) return STOPPED;
    if (injected) return { ok: false, error: injected };

    let listed: ListedFiles;
    try {
      listed = await this.briefFiles(jobDir);
    } catch (err) {
      if (signal.aborted) return STOPPED;
      if (!(err instanceof UnzipError)) throw err;
      return { ok: false, error: `${BRIEF_STOPPED} ${err.message}` };
    }
    const { files, zips } = listed;
    const note = briefNote(job.note);
    // A folder with no footage may be an edit of clips in the client's _Shared, not a generated video.
    const shared =
      this.generate && !files.some(isDraftFootage) ? await this.refreshShared(job) : [];
    const fingerprint = briefFingerprint(files, note, shared);

    const existing = await readFinishedBrief(jobDir);
    if (
      existing !== null &&
      existing.fingerprint === fingerprint &&
      !(this.songs && briefNamesUnreadSong(existing, files))
    ) {
      await this.save(job, jobDir, existing, note);
      this.logger.info({ jobId: job.id, fingerprint }, 'brief reused: nothing changed');
      return { ok: true, source: 'reused', brief: existing };
    }

    let draft: BriefDraft;
    let source: BriefSource;
    // Unknown kinds (`other`) say nothing about how to edit, so they don't stop the skip. The
    // fingerprint above still covers them: changing one gives a new brief.
    // With Generate on a zip is not "unknown": it holds the client's references, or the script. And
    // a video under reference/ is style to match, never footage, so it is not "only video" either.
    const skippable = (file: BriefFile): boolean =>
      (file.kind === 'video' || file.kind === 'other') &&
      !(this.generate && (isZipName(file.relPath) || isReferencePath(file.relPath)));
    if (note === null && files.every(skippable)) {
      draft = noInstructionsBrief(
        files.map((file) => file.relPath),
        files.filter((file) => file.kind === 'other').map((file) => file.relPath),
      );
      source = 'skipped';
    } else if (this.draft && files.some(isDraftFootage)) {
      // Draft & chat: the Draft reads the instructions itself (4b).
      draft = draftPendingBrief(files.map((file) => ({ path: file.relPath, kind: file.kind })));
      source = 'pending';
    } else {
      const written = await this.write(job, jobDir, files, zips, note, shared, context);
      if (!written.ok) return written;
      draft = written.draft;
      source = 'ran';
    }

    // The skip's brief goes through the same check, so the two can never differ in shape.
    const checked = briefDraftSchema.safeParse(draft);
    if (!checked.success)
      return { ok: false, error: schemaMismatch(firstBriefIssue(checked.error)) };
    const brief: Brief = { schema: BRIEF_SCHEMA_VERSION, fingerprint, ...checked.data };
    await this.save(job, jobDir, brief, note);
    this.logger.info({ jobId: job.id, source, fingerprint }, 'brief written');
    return { ok: true, source, brief };
  }

  /**
   * The files the brief is about: the job's own; with the Generate switch on, the files unpacked
   * from its zips, marked with the zip they came from (GN4); and, with the Songs switch on, the
   * pictures attached to its note, marked `attached` (SG5). Sorted by `relPath`, like the scanner's
   * list. `zips` are the job's zips (relative paths), empty with the switch off. Throws
   * `UnzipError` for a zip that is refused.
   */
  private async briefFiles(jobDir: string): Promise<ListedFiles> {
    const scanned: BriefFile[] = await listJobFiles(jobDir, { exportsDir: this.exportsDir });
    const more: BriefFile[] = [];
    let zips: string[] = [];

    if (this.generate) {
      const archives = await unpackJobArchives(jobDir, scanned);
      zips = [...archives.zips];
      for (const file of archives.files) {
        more.push({
          relPath: file.relPath,
          absPath: file.absPath,
          kind: classifyFile(file.relPath),
          size: file.size,
          mtimeMs: file.mtimeMs,
          fromZip: file.fromZip,
          contentKey: file.crc,
        });
      }
    }
    if (this.songs) {
      for (const picture of await listNoteAttachments(jobDir)) {
        more.push({
          relPath: noteAttachmentRelPath(picture.name),
          absPath: picture.absPath,
          kind: classifyFile(picture.name),
          size: picture.bytes,
          mtimeMs: picture.mtimeMs,
          attached: true,
        });
      }
    }
    if (more.length === 0) return { files: scanned, zips };
    return {
      files: [...scanned, ...more].sort((a, b) =>
        a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
      ),
      zips,
    };
  }

  /**
   * Phase 2 plan §6: copies the client's `_Style` into edit/style/ when the job has none yet and
   * the client has a style.md. Done once: Retry and Resume find the copy and leave it, so the job
   * keeps the style it started with. History lives in the data folder, not in `_Style`, so it is
   * not in the copy; the style run's `style.md.new` and dot files are left out.
   *
   * It is made next to its place and renamed, so a copy that was cut short never passes for the
   * job's style. `COPYFILE_FICLONE` makes an APFS clone where the volume can and a plain copy
   * where it can't. Links are followed: the copy must not change when `_Style` does.
   */
  private async freezeStyle(job: Job, jobDir: string): Promise<void> {
    const target = join(jobDir, STYLE_COPY_PATH);
    if (await exists(target)) return;
    if (!(await isFile(styleFileFor(this.inboxPath, job.client)))) return;

    const source = styleDirFor(this.inboxPath, job.client);
    const staging = join(jobDir, STYLE_STAGING_PATH);
    await rm(staging, { recursive: true, force: true });
    await mkdir(dirname(staging), { recursive: true });
    try {
      await cp(source, staging, {
        recursive: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (path) => {
          const name = relative(source, resolve(path));
          return !basename(name).startsWith('.') && name !== STYLE_IN_PROGRESS;
        },
      });
      await rename(staging, target);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    this.logger.info({ jobId: job.id, client: job.client }, 'brief: the client’s style is copied');
  }

  /**
   * Series plan §4: copies an episode's series folder, `_Series/<name>/`, into edit/series/ once,
   * like {@link freezeStyle} (without history, series.md.new or dot files). Retry and Resume keep
   * the copy, whatever `_Series` becomes later. Does nothing for a job outside a series, and a
   * series with no series.md yet (its format is still being learned) is not copied: the job gets
   * no Series section until a later attempt finds one, and the log says why.
   */
  private async freezeSeries(job: Job, jobDir: string): Promise<void> {
    if (job.seriesId === null || this.series === undefined) return;
    const target = join(jobDir, SERIES_COPY_PATH);
    if (await exists(target)) return;

    const name = this.series.get(job.seriesId)?.name;
    if (name === undefined || !(await isFile(seriesFileFor(this.inboxPath, job.client, name)))) {
      this.logger.warn(
        { jobId: job.id, seriesId: job.seriesId, series: name ?? null },
        'brief: the series has no series.md yet, so the episode is built without it',
      );
      return;
    }

    const source = seriesDirFor(this.inboxPath, job.client, name);
    const staging = join(jobDir, SERIES_STAGING_PATH);
    await rm(staging, { recursive: true, force: true });
    await mkdir(dirname(staging), { recursive: true });
    try {
      await cp(source, staging, {
        recursive: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (path) => {
          const relPath = relative(source, resolve(path));
          return !basename(relPath).startsWith('.') && relPath !== SERIES_NEW_FILE_NAME;
        },
      });
      await rename(staging, target);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    this.logger.info(
      { jobId: job.id, series: name },
      'brief: the series is copied, the episode is built from it',
    );
  }

  /**
   * The name of the job's series, as its folder in `_Series` is called. From the series' row; when
   * the row is gone (the folder was deleted by hand), the job's own name without its number, so a
   * retried episode keeps the section of the copy it froze.
   */
  private seriesName(job: Job): string {
    const stored = job.seriesId === null ? undefined : this.series?.get(job.seriesId);
    return stored?.name ?? seriesNameFrom(job.name);
  }

  /** Runs the writer and reads its draft. */
  private async write(
    job: Job,
    jobDir: string,
    files: readonly BriefFile[],
    zips: readonly string[],
    note: string | null,
    shared: readonly string[],
    context: BriefContext,
  ): Promise<{ ok: true; draft: BriefDraft } | { ok: false; error: string }> {
    const { signal } = context;
    // A brief from before (another fingerprint) must not pass for the new one if the run writes
    // nothing. The transcripts stay: the transcribe helper reuses them, and they cost money.
    await rm(join(jobDir, BRIEF_JSON_PATH), { force: true });
    await rm(join(jobDir, BRIEF_MD_PATH), { force: true });

    // The section is made from the frozen copy (see `save`), so the run is told about the series
    // only when that copy is there: otherwise no section follows the brief.
    const frozen = await readFrozenSeries(jobDir, this.seriesName(job), job.episode);
    const series = frozen === null ? null : { name: frozen.name, episode: frozen.episode };

    const reading = files.filter((file) => file.kind !== 'video').length;
    context.progress(`reading ${plural(reading, 'file', 'files')}`);
    const audioFiles = files.filter((file) => file.kind === 'audio').length;
    const counter = this.countTranscripts(jobDir, audioFiles, context);

    let outcome: BriefWriteOutcome;
    try {
      outcome = await this.writer.write(job, {
        jobDir,
        files,
        note,
        series,
        ...(shared.length > 0 ? { shared } : {}),
        signal,
      });
    } finally {
      await counter.stop();
    }
    if (signal.aborted) return STOPPED;
    if (!outcome.ok) return outcome;

    const json = await readBriefJson(jobDir);
    if (!json.ok) return { ok: false, error: schemaMismatch(json.issue) };
    const parsed = briefDraftSchema.safeParse(json.value);
    if (!parsed.success) return { ok: false, error: schemaMismatch(firstBriefIssue(parsed.error)) };
    await this.warnUntranscribed(job, jobDir, files, parsed.data);
    const draft = this.musicKeys(job, this.generatedKeys(job, parsed.data, zips));
    return { ok: true, draft: this.canvasFromNote(job, draft, note) };
  }

  /**
   * What a run must not decide, put right after it wrote (Generated videos, GN4):
   * - Switch off: `production`, `voiceover` and `budgetUsd` are null whatever the run wrote, so a
   *   brief is what it was before those keys existed. `formats` stays: a second size is asked for
   *   by any job, not only a generated one (Formats, GN7).
   * - Switch on: a zip of the job folder has the role `ignore` (its files are listed on their own;
   *   a zip the run left out is added), and `canvas` is the first of `formats` when the run left it
   *   null (the main format is the one named first; stated, so not assumed).
   */
  private generatedKeys(job: Job, draft: BriefDraft, zips: readonly string[]): BriefDraft {
    if (!this.generate) {
      if (draft.production === null && draft.voiceover === null && draft.budgetUsd === null) {
        return draft;
      }
      this.logger.warn(
        { jobId: job.id },
        'brief: the Generate switch is off, so production, voiceover and budgetUsd are dropped',
      );
      return { ...draft, production: null, voiceover: null, budgetUsd: null };
    }

    let files = draft.files;
    for (const zip of zips) {
      const entry = files.find((file) => file.path === zip);
      if (entry === undefined) files = [...files, { path: zip, role: 'ignore', note: null }];
      else if (entry.role !== 'ignore') {
        files = files.map((file) => (file === entry ? { ...file, role: 'ignore' } : file));
      }
    }
    const main = draft.formats?.[0] ?? null;
    const canvas = draft.canvas ?? main;
    if (canvas !== draft.canvas) {
      this.logger.info({ jobId: job.id, canvas }, 'brief: the canvas is the first of the formats');
    }
    return { ...draft, files, canvas };
  }

  /**
   * Music only when asked (U21): with the music switch off, `music.wanted` is false whatever the run
   * wrote, so a brief is what it was before the key existed.
   */
  private musicKeys(job: Job, draft: BriefDraft): BriefDraft {
    if (this.music || !draft.music?.wanted) return draft;
    this.logger.warn(
      { jobId: job.id },
      'brief: the music switch is off, so music.wanted is dropped',
    );
    return { ...draft, music: { ...draft.music, wanted: false } };
  }

  /** P21 (CVP-136): see `noteStatesCanvas`. The draft as it is when the note doesn't state it. */
  private canvasFromNote(job: Job, draft: BriefDraft, note: string | null): BriefDraft {
    if (!draft.assumed.includes('canvas') || !noteStatesCanvas(note, draft.canvas)) return draft;
    this.logger.info(
      { jobId: job.id, canvas: draft.canvas },
      'brief: the note states the canvas, so it is not assumed',
    );
    return { ...draft, assumed: draft.assumed.filter((path) => path !== 'canvas') };
  }

  /**
   * P18 (CVP-133): a voice note the brief calls `instructions` has no transcript in
   * edit/brief/transcripts/, so its words can't be in the brief. The brief is still accepted (the
   * edit run transcribes it again), but the engine log says so. A warning only.
   */
  private async warnUntranscribed(
    job: Job,
    jobDir: string,
    files: readonly JobFile[],
    draft: BriefDraft,
  ): Promise<void> {
    const audio = new Set(files.filter((file) => file.kind === 'audio').map((f) => f.relPath));
    for (const entry of draft.files) {
      if (entry.role !== 'instructions' || !audio.has(entry.path)) continue;
      // The helper writes `<file name without extension>.json`.
      const transcript = join(jobDir, BRIEF_TRANSCRIPTS_PATH, `${parse(entry.path).name}.json`);
      if (await isFile(transcript)) continue;
      this.logger.warn(
        { jobId: job.id, file: entry.path },
        'brief written without a transcript of a voice note that carries instructions',
      );
    }
  }

  /**
   * While the writer runs: "voice notes n" once transcripts show up in edit/brief/transcripts/.
   * Nothing for a job without audio. There is no total on purpose: which audio files get a
   * transcript is the run's call (a voice note yes, a music track no; a .mp3, .wav or .aac only
   * when it is short), so no M the engine could give would stay true, and a music track would
   * leave "n/M" stuck below M. `audioFiles` only caps n, so a transcript left from a file that is
   * gone does not count.
   */
  private countTranscripts(jobDir: string, audioFiles: number, context: BriefContext) {
    const dir = join(jobDir, BRIEF_TRANSCRIPTS_PATH);
    let stopped = audioFiles === 0;
    let shown = 0;
    let looking: Promise<void> = Promise.resolve();

    const look = async (): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return; // not there yet
      }
      const done = Math.min(
        names.filter((name) => !name.startsWith('.') && name.toLowerCase().endsWith('.json'))
          .length,
        audioFiles,
      );
      if (stopped || context.signal.aborted || done === 0 || done === shown) return;
      shown = done;
      context.progress(`voice notes ${done}`);
    };

    const timer = stopped
      ? undefined
      : setInterval(() => {
          looking = looking.then(look);
        }, this.pollIntervalMs);

    return {
      async stop(): Promise<void> {
        stopped = true;
        clearInterval(timer);
        await looking;
      },
    };
  }

  /**
   * Writes brief.json (pretty, ending in a newline) and renders brief.md next to it, with the
   * client's shared files, an episode's frozen series, the job's frozen style, the shared fonts and
   * the Graphics library when it has them. The one place brief.md is written, so a brief that was reused,
   * skipped or written by a run all get those sections.
   */
  private async save(job: Job, jobDir: string, brief: Brief, note: string | null): Promise<void> {
    await writeAtomic(join(jobDir, BRIEF_JSON_PATH), `${JSON.stringify(brief, null, 2)}\n`);
    const { schema: _schema, fingerprint: _fingerprint, ...draft } = brief;
    const fonts = await this.refreshFonts(job, jobDir);
    const shared = await this.refreshShared(job);
    const graphics = await this.refreshGraphics(job, jobDir);
    const style = await readFrozenStyle(jobDir);
    const series = await readFrozenSeries(jobDir, this.seriesName(job), job.episode);
    await writeAtomic(
      join(jobDir, BRIEF_MD_PATH),
      renderBriefMd(draft, {
        client: job.client,
        job: job.name,
        note,
        shared,
        fonts,
        style,
        series,
        graphics,
        ...(this.music ? { music: true } : {}),
      }),
    );
  }

  /**
   * CVP-201: copies the shared fonts into edit/fonts/ again and answers what is in it. Fonts never
   * fail a brief: when the copy fails the log says so and the job goes on with the fonts it had.
   */
  private async refreshFonts(job: Job, jobDir: string): Promise<string[]> {
    try {
      const fonts = await copySharedFonts(this.inboxPath, jobDir);
      if (fonts.length > 0) {
        this.logger.info(
          { jobId: job.id, fonts: fonts.length },
          'brief: the shared fonts are copied',
        );
      }
      return fonts;
    } catch (err) {
      this.logger.warn({ jobId: job.id, err }, 'brief: the shared fonts could not be copied');
      return listFonts(join(jobDir, FONTS_COPY_PATH)).catch(() => []);
    }
  }

  /**
   * The files in the client's `_Shared` for brief.md. Like the fonts, shared files never fail a
   * brief: when the folder can't be read the log says so and brief.md has no section for them.
   */
  private async refreshShared(job: Job): Promise<string[]> {
    try {
      return await listSharedFiles(sharedDirFor(this.inboxPath, job.client));
    } catch (err) {
      this.logger.warn(
        { jobId: job.id, err },
        'brief: the client’s shared files could not be read',
      );
      return [];
    }
  }

  /**
   * GR8: makes edit/graphics/ a fresh copy of the Graphics library and answers what is in it for
   * brief.md. Every live graphic with "Edits can use it" on and a version is copied from
   * `<inbox>/_Graphics/<folder>/versions/vN/` to edit/graphics/<id>/, whole (its index.html,
   * vendor/ and about.json cost nothing and stay). Like the fonts it is made next to its place and
   * renamed, with `COPYFILE_FICLONE`, and the old copy goes, so a graphic that was deleted or turned
   * off, or moved to another version, never lingers.
   *
   * A graphic that cannot be copied (its folder is gone, its version has no
   * compositions/lib-<id>.html) is left out, with a warning; the others are copied. Graphics never
   * fail a brief. `undefined` while the step was built without the library (the switch is off):
   * nothing is touched then.
   */
  private async refreshGraphics(job: Job, jobDir: string): Promise<BriefGraphic[] | undefined> {
    const library = this.graphics;
    if (library === undefined) return undefined;

    const target = join(jobDir, GRAPHICS_COPY_PATH);
    const staging = join(jobDir, GRAPHICS_STAGING_PATH);
    const copied: BriefGraphic[] = [];
    try {
      await rm(staging, { recursive: true, force: true });
      for (const graphic of library.list()) {
        if (!graphic.uses || graphic.version === null) continue;
        try {
          copied.push(await this.copyGraphic(graphic, graphic.version, staging));
        } catch (err) {
          this.logger.warn(
            { jobId: job.id, graphic: graphic.name, graphicId: graphic.id, err },
            'brief: a graphic of the library could not be copied',
          );
        }
      }
      await rm(target, { recursive: true, force: true });
      if (copied.length === 0) {
        await rm(staging, { recursive: true, force: true });
        return copied;
      }
      await rename(staging, target);
      this.logger.info(
        { jobId: job.id, graphics: copied.length },
        'brief: the graphics library is copied',
      );
      return copied;
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      this.logger.warn({ jobId: job.id, err }, 'brief: the graphics library could not be copied');
      return [];
    }
  }

  /** Copies one graphic's version into `<staging>/<id>/` and answers its line for brief.md. */
  private async copyGraphic(
    graphic: StoredGraphic,
    version: number,
    staging: string,
  ): Promise<BriefGraphic> {
    if (graphic.lengthSec === null) throw new Error('its length is not known');
    const source = graphicVersionDir(graphicDir(this.inboxPath, graphic.folder), version);
    const to = join(staging, graphic.id);
    await mkdir(staging, { recursive: true });
    try {
      await cp(source, to, {
        recursive: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (path) => !basename(relative(source, resolve(path))).startsWith('.'),
      });
      if (!(await isFile(join(to, 'compositions', `lib-${graphic.id}.html`)))) {
        throw new Error(`v${version} has no compositions/lib-${graphic.id}.html`);
      }
    } catch (err) {
      // What was copied of it must not end up in edit/graphics/ with the graphics that were whole.
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    return {
      id: graphic.id,
      name: graphic.name,
      kind: graphic.kind,
      lengthSec: graphic.lengthSec,
      when: graphic.when,
      variables: graphic.variables.map(({ id, label }) => ({ id, label })),
    };
  }
}
