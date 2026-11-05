// A font named in a note reaches the run (Fonts build 2, FN15, and FN16 for a name it lacks).
// OWNER: FN15.
//
//   a run starts (an edit: the job's note; a revise: edit/review/round-N.md)
//     ─▶ resolveNoteFonts (FN12) against the font index (FN3): any `@Heebo Bold` in the text?
//     ─▶ each font's file must be in the job's edit/fonts/ (the Brief step copied the library
//        there before the edit; a font imported since is copied now, the one file, at the same path)
//     ─▶ font_uses (family, weight, italic, job, round, source token) added once per font per run
//     ─▶ RunLibraryRefs.fonts on the run's context: the Claude runner puts them in the prompt, in
//        the same "Library references" block as the LUTs and graphics (fonts-use.md), and the fake
//        runner records them in edit/library-refs.json
//     ─▶ a name the library does not have (`@Gotham Bold`, FN16) goes on the context as
//        RunLibraryRefs.unresolvedFonts (the prompt tells the run to use the closest font and say
//        which) and is written to font_requests (name, job, round) once, which the Fonts page
//        shows as a banner until the font is imported; the browsers hear `font.requested`
//
// The hook is a Runner that wraps the engine's (`withFontRefs`), like `withLutRefs`; the engine
// wraps only while the Fonts and fontsInNotes switches are both on, so with either off nothing
// here runs and an `@Heebo Bold` in a note is plain text, as it always was.
//
// Nothing here can fail a run. A catalog that cannot be read, a file that cannot be put in the job
// and a use that cannot be written are logged and the run starts without that part.
//
// A quick fix in Review (`withQuickFixFonts`) gets the same: a note that names a font has its file
// put in the job's edit/fonts/ before the fix starts, since a job whose edit began before the
// library had that font (or before there was a library) has no copy of it, and the fix looks for
// the file there. The fix is not told anything more: it lists edit/fonts/ as it always did.
//
// A use is counted when the file is handed to the run, not when it ends, and a retry or a resume of
// the same round counts once (`addUse` ignores a row it already has).
//
// A name the library does not have (`@Gotham Bold`, FN16) never stops the run: it is kept in
// `unresolvedFonts` (the prompt tells the run to use the closest font that is there and say which
// one it used) and a `font_requests` row is written for it: the name as written, the job and the
// round. The same name for the same job and round is one request, so a retry or a resume adds none
// and tells the browsers nothing (`font.requested` goes out only for a row that was added). The
// Fonts page shows the banner for the open ones; an import of the font settles them (FN4).

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FontRequestedEvent } from '@studio/shared';
import type { FontRepository } from '../db/index.js';
import { copyWhole, lutRunNotes } from '../luts/lut-job-files.js';
import type { RunFont, RunLibraryRefs, Runner } from '../pipeline/runner.js';
import { FONTS_COPY_PATH, fontsDirFor } from '../pipeline/shared-fonts.js';
import type { WorkerLogger } from '../pipeline/worker.js';
import type { QuickFixRunner } from '../review/quick-fix-run.js';
import { type FontCatalog, type NoteFont, resolveNoteFonts } from './font-tokens.js';

const SILENT: WorkerLogger = { info() {}, warn() {}, error() {} };

export interface FontRunRefsOptions {
  /** The faces the library has: `FontService.catalog` (it waits for the index's first build). */
  catalog: () => Promise<FontCatalog>;
  /** The use counts. */
  uses: Pick<FontRepository, 'addUse'>;
  /** FN16: the fonts a note asked for that the library does not have (the Fonts page's banner). */
  requests: Pick<FontRepository, 'recordRequest'>;
  /** FN16: tells the browsers a request was added (`font.requested`). The engine's bus. */
  publish?: (event: FontRequestedEvent) => void;
  /** `Config.inboxPath`: the library is `<inboxPath>/_Fonts`. */
  inboxPath: string;
  logger?: WorkerLogger;
}

/** What one run's notes say about fonts. */
export interface FontRunRefs {
  /** The fonts the notes name that the library has and the job has a file of, each once. */
  fonts: RunFont[];
  /** The names the notes write that the library does not have, each once. */
  unresolved: string[];
}

/** What one run's notes are: the texts to look for tokens in, and the round the use belongs to. */
export interface FontRunNotes {
  jobId: string;
  /** The job's folder in the inbox. */
  jobDir: string;
  /** 0 for the edit, n for review round n (the `round` of `font_uses`). */
  round: number;
  /** Every text of this run that can name something. */
  texts: readonly string[];
}

/** A path inside `_Fonts` that stays inside it: no empty or `..` part. */
function insideFonts(file: string): boolean {
  return file.split('/').every((part) => part !== '' && part !== '..' && part !== '.');
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The job's copy of a font's file, `edit/fonts/<file>`: the one the Brief step made, else (a font
 * imported after the edit began, named in a round of notes) a copy of that single file made now, at
 * the same path the Brief step would have given it. Throws when there is no way to have it.
 */
async function fontInJob(options: FontRunRefsOptions, jobDir: string, file: string) {
  if (!insideFonts(file)) throw new Error('the font’s path leaves the fonts folder');
  const path = `${FONTS_COPY_PATH}/${file}`;
  const target = join(jobDir, FONTS_COPY_PATH, ...file.split('/'));
  if (!(await isFile(target))) {
    await copyWhole(join(fontsDirFor(options.inboxPath), ...file.split('/')), target);
  }
  return path;
}

function toRunFont(font: NoteFont, path: string): RunFont {
  return {
    face: font.face,
    family: font.family,
    weight: font.weight,
    italic: font.italic,
    path,
    he: font.he,
  };
}

/**
 * Looks for font tokens in the run's texts and, when there are any, makes sure the job has the
 * files, counts the uses and answers what the run is told. `null` when the texts name no font and
 * write no font name the library lacks.
 */
export async function prepareFontRefs(
  options: FontRunRefsOptions,
  notes: FontRunNotes,
): Promise<FontRunRefs | null> {
  const { logger = SILENT } = options;
  const text = notes.texts.join('\n');
  // Every font token starts with an @: most notes need no look at the library.
  if (!text.includes('@')) return null;

  const { fonts: named, unresolved } = resolveNoteFonts(text, await options.catalog());

  const fonts: RunFont[] = [];
  for (const font of named) {
    try {
      fonts.push(toRunFont(font, await fontInJob(options, notes.jobDir, font.file)));
    } catch (err) {
      // The run goes on without this font, as if the note had not asked for it.
      logger.warn(
        { err, jobId: notes.jobId, font: font.face },
        'could not put a font a note names into the job',
      );
    }
  }

  for (const font of fonts) {
    try {
      options.uses.addUse({
        family: font.family,
        weight: font.weight,
        italic: font.italic,
        jobId: notes.jobId,
        round: notes.round,
        source: 'token',
      });
    } catch (err) {
      logger.warn({ err, jobId: notes.jobId, font: font.face }, 'could not count a font use');
    }
  }

  // The job does not wait for what is missing and does not fail because of it: the request is
  // only written down (once per name, job and round), and the browsers are told when it is new.
  for (const name of unresolved) {
    try {
      const { added } = options.requests.recordRequest(name, notes.jobId, notes.round);
      if (added) options.publish?.({ type: 'font.requested', name });
    } catch (err) {
      logger.warn({ err, jobId: notes.jobId, font: name }, 'could not write down a missing font');
    }
  }

  if (fonts.length + unresolved.length === 0) return null;
  return { fonts, unresolved };
}

/**
 * The runner with the font tokens of its notes resolved first (FN15): when the run's notes name a
 * font, its file is made sure of in the job, the use counted and the answer goes on the run's
 * context (`libraryRefs.fonts`) to the runner it wraps, next to whatever an outer wrapper
 * (`withLutRefs`) already put there. Whatever goes wrong here only costs the run its font
 * references: it is logged and the run starts as it would have without the switch.
 */
export function withFontRefs(
  runner: Runner,
  options: FontRunRefsOptions,
  logger: WorkerLogger = SILENT,
): Runner {
  return {
    async start(job, mode, context) {
      let found: FontRunRefs | null = null;
      try {
        const notes = await lutRunNotes(job, join(options.inboxPath, job.relPath));
        if (notes !== null) found = await prepareFontRefs(options, notes);
      } catch (err) {
        logger.warn({ err, jobId: job.id }, 'could not look at the font tokens of the notes');
      }
      if (found === null) return runner.start(job, mode, context);
      const before: RunLibraryRefs = context.libraryRefs ?? { luts: [], graphics: [], missing: [] };
      const libraryRefs: RunLibraryRefs = {
        ...before,
        ...(found.fonts.length > 0 ? { fonts: found.fonts } : {}),
        ...(found.unresolved.length > 0 ? { unresolvedFonts: found.unresolved } : {}),
      };
      return runner.start(job, mode, { ...context, libraryRefs });
    },
  };
}

/**
 * The quick fix runner with the font tokens of its note resolved first: a font the note names has
 * its file made sure of in the job's edit/fonts/ (the one file, at the library's path), the use
 * counted for the round the note will be stamped with, and a name the library lacks written down
 * for the Fonts page, as for an edit or a revise run. A fix whose note names no font (nearly all of
 * them) is not touched. Whatever goes wrong here is logged and the fix starts as it would have
 * without it: the note then says what it can, and goes with Send.
 */
export function withQuickFixFonts(
  runner: QuickFixRunner,
  options: FontRunRefsOptions,
  logger: WorkerLogger = SILENT,
): QuickFixRunner {
  return {
    kind: runner.kind,
    async run(request) {
      const { job, note, fix } = request;
      if (note.text?.includes('@')) {
        try {
          await prepareFontRefs(options, {
            jobId: job.id,
            jobDir: join(options.inboxPath, job.relPath),
            round: fix.round,
            texts: [note.text],
          });
        } catch (err) {
          logger.warn({ err, jobId: job.id }, 'could not look at the font tokens of the note');
        }
      }
      return runner.run(request);
    },
  };
}
