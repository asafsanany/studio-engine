import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontRepository } from '../db/font-repository.js';
import { fakeClock, memoryDb, rawRow } from '../db/test-utils.js';
import { makeJob } from '../events/test-utils.js';
import { hasFfmpeg } from '../luts/lut-test-utils.js';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import { FakeRunner, LIBRARY_REFS_FILE } from '../pipeline/fake-runner.js';
import type { RunContext, RunLibraryRefs, Runner } from '../pipeline/runner.js';
import { copySharedFonts } from '../pipeline/shared-fonts.js';
import type { QuickFixOutcome, QuickFixRequest, QuickFixRunner } from '../review/quick-fix-run.js';
import { createFontIndex, type FontIndex } from './font-index.js';
import {
  type FontRunNotes,
  type FontRunRefsOptions,
  prepareFontRefs,
  withFontRefs,
  withQuickFixFonts,
} from './font-run-refs.js';
import { FIXTURE_FONTS } from './font-test-utils.js';
import type { FontCatalog } from './font-tokens.js';
import { makeLibrary, type TempLibrary } from './library/test-utils.js';

// FN15: the fonts a note names reach the run. Real fixture fonts in a temp inbox, the real font
// index over them, a real repository on an in-memory database.

const HEEBO_LIKE = 'Hebrew + English/Secular One/SecularOne-Regular.ttf';
const BELLEFAIR = 'Hebrew + English/Bellefair/Bellefair-Regular.ttf';
const OUTFIT = 'English only/Outfit/Outfit-Regular.ttf';
const OUTFIT_BOLD = 'English only/Outfit/Outfit-Bold.ttf';

let library: TempLibrary;
let jobDir: string;
let index: FontIndex;
let db: ReturnType<typeof memoryDb>;
let repo: FontRepository;
const warn = vi.fn();
const logger = { info: vi.fn(), warn, error: vi.fn() };

beforeEach(async () => {
  library = makeLibrary();
  jobDir = join(library.inbox, 'Acme', 'Teaser');
  mkdirSync(join(jobDir, 'edit'), { recursive: true });
  // The library the edit began with: two Hebrew fonts and Outfit Regular. They are copied into the
  // job the way the Brief step does it.
  library.putFixture(HEEBO_LIKE, 'SecularOne-Regular.ttf');
  library.putFixture(BELLEFAIR, 'Bellefair-Regular.ttf');
  library.putFixture(OUTFIT, 'Outfit-Regular.ttf');
  await copySharedFonts(library.inbox, jobDir);
  db = memoryDb();
  repo = new FontRepository(db, { clock: fakeClock() });
  index = createFontIndex({ dir: library.dir, logger });
  await index.refresh();
  warn.mockClear();
});

afterEach(() => {
  library.cleanup();
});

function options(over: Partial<FontRunRefsOptions> = {}): FontRunRefsOptions {
  return {
    catalog: async () => index.catalog(),
    uses: repo,
    requests: repo,
    inboxPath: library.inbox,
    logger,
    ...over,
  };
}

const notes = (text: string, round = 0, jobId = 'job1'): FontRunNotes => ({
  jobId,
  jobDir,
  round,
  texts: [text],
});

const jobFont = (rel: string) => join(jobDir, 'edit', 'fonts', ...rel.split('/'));

describe('a note that names no font', () => {
  it.each([
    'Make it brighter and cut the intro',
    '',
    'mail me at a@example.com',
    'ask @gotham, in lower case, about it',
  ])('leaves the job alone: %j', async (text) => {
    expect(await prepareFontRefs(options(), notes(text))).toBeNull();
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });

  it('does not even ask the library when the text has no @', async () => {
    const catalog = vi.fn(async () => index.catalog());
    expect(await prepareFontRefs(options({ catalog }), notes('Make it brighter'))).toBeNull();
    expect(catalog).not.toHaveBeenCalled();
  });

  it('a LUT or a graphic token is not a font and not a missing font', async () => {
    expect(
      await prepareFontRefs(
        options(),
        notes('Grade it with @luts/golden-hour and @graphics/intro'),
      ),
    ).toBeNull();
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });
});

describe('a note that names one font', () => {
  it('tells the run the file in the job’s edit/fonts/, and counts the use once, as a token', async () => {
    const answer = await prepareFontRefs(
      options(),
      notes('Put the captions in @Secular One', 2, 'job9'),
    );

    expect(answer).toEqual({
      fonts: [
        {
          face: 'Secular One',
          family: 'Secular One',
          weight: 400,
          italic: false,
          path: `edit/fonts/${HEEBO_LIKE}`,
          he: true,
        },
      ],
      unresolved: [],
    });
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({
        family: 'Secular One',
        weight: 400,
        italic: 0,
        job_id: 'job9',
        round: 2,
        source: 'token',
      }),
    ]);
    // The file the prompt names is there.
    expect(existsSync(join(jobDir, answer?.fonts[0]?.path ?? 'nope'))).toBe(true);
  });

  it('says whether the font has the Hebrew letters', async () => {
    const answer = await prepareFontRefs(options(), notes('Titles in @Outfit'));
    expect(answer?.fonts).toEqual([
      expect.objectContaining({ face: 'Outfit', he: false, weight: 400 }),
    ]);
  });

  it('counts a font named twice, or run twice (a retry, a resume), once', async () => {
    const text = 'Captions @Secular One, titles @secular  one';
    const first = await prepareFontRefs(options(), notes(text));
    expect(first?.fonts).toHaveLength(1);
    await prepareFontRefs(options(), notes(text));
    await prepareFontRefs(options(), notes(text));
    expect(rawRow(db, 'font_uses')).toHaveLength(1);
    // Another round of the same job is another use.
    await prepareFontRefs(options(), notes(text, 1));
    expect(rawRow(db, 'font_uses')).toHaveLength(2);
    expect(repo.usedCount('Secular One')).toBe(1);
  });

  it('finds a font inside Hebrew text', async () => {
    const answer = await prepareFontRefs(options(), notes('הכותרות ב-@Secular One בבקשה'));
    expect(answer?.fonts.map((font) => font.face)).toEqual(['Secular One']);
  });
});

describe('a note that names two fonts', () => {
  it('tells both, in the order the note names them, and counts both', async () => {
    const answer = await prepareFontRefs(
      options(),
      notes('The captions in @Outfit and the titles in @Bellefair', 1),
    );
    expect(answer?.fonts.map((font) => [font.face, font.path])).toEqual([
      ['Outfit', `edit/fonts/${OUTFIT}`],
      ['Bellefair', `edit/fonts/${BELLEFAIR}`],
    ]);
    expect(
      (rawRow(db, 'font_uses') as { family: string }[]).map((row) => row.family).sort(),
    ).toEqual(['Bellefair', 'Outfit']);
  });
});

describe('a note that names a font and a LUT or a graphic', () => {
  it('answers the font only: the other kinds are left to their own part', async () => {
    const answer = await prepareFontRefs(
      options(),
      notes('Use @luts/golden-hour for the grade, @Bellefair for the titles and @graphics/intro'),
    );
    expect(answer).toEqual({
      fonts: [expect.objectContaining({ face: 'Bellefair' })],
      unresolved: [],
    });
    expect(rawRow(db, 'font_uses')).toHaveLength(1);
  });
});

describe('a font the library does not have', () => {
  it('is kept in unresolved, not told as a font and not counted', async () => {
    const answer = await prepareFontRefs(
      options(),
      notes('Captions in @Gotham Bold, titles in @Outfit'),
    );
    expect(answer).toEqual({
      fonts: [expect.objectContaining({ face: 'Outfit' })],
      unresolved: ['Gotham Bold'],
    });
    expect(rawRow(db, 'font_uses')).toHaveLength(1);
  });

  it('is all there is when it is the only name', async () => {
    expect(await prepareFontRefs(options(), notes('Use @Gotham Bold for the titles'))).toEqual({
      fonts: [],
      unresolved: ['Gotham Bold'],
    });
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });

  it('with an empty library every name is missing and nothing is counted', async () => {
    const empty: FontCatalog = { faces: [] };
    expect(
      await prepareFontRefs(options({ catalog: async () => empty }), notes('Use @Outfit Bold')),
    ).toEqual({ fonts: [], unresolved: ['Outfit Bold'] });
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });
});

describe('a font the library does not have: the request (FN16)', () => {
  const published: unknown[] = [];
  const publish = (event: unknown) => published.push(event);
  beforeEach(() => {
    published.length = 0;
  });

  it('writes down the name as the note wrote it, with the job and the round', async () => {
    await prepareFontRefs(options({ publish }), notes('Titles in @Gotham Bold', 2, 'job7'));

    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ name: 'Gotham Bold', job_id: 'job7', round: 2, resolved_at: null }),
    ]);
    expect(published).toEqual([{ type: 'font.requested', name: 'Gotham Bold' }]);
  });

  it('writes each missing name once, in the order the note names them, and none for a font that is there', async () => {
    await prepareFontRefs(
      options({ publish }),
      notes(
        'Captions in @Gotham Bold, titles in @Outfit, the end in @Proxima Nova, again @Gotham Bold',
      ),
    );

    expect(
      repo
        .openRequests(0)
        .map((request) => request.name)
        .sort(),
    ).toEqual(['Gotham Bold', 'Proxima Nova']);
    // ... and the browsers hear of them in the order the note names them.
    expect(published).toEqual([
      { type: 'font.requested', name: 'Gotham Bold' },
      { type: 'font.requested', name: 'Proxima Nova' },
    ]);
  });

  it('a retry or a resume of the same round adds nothing and tells nobody again', async () => {
    const run = () => prepareFontRefs(options({ publish }), notes('Use @Gotham Bold', 1, 'job7'));
    await run();
    await run();
    await run();

    expect(rawRow(db, 'font_requests')).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('another round, or another job, asking for the same name is a request of its own', async () => {
    await prepareFontRefs(options({ publish }), notes('Use @Gotham Bold', 1, 'job7'));
    await prepareFontRefs(options({ publish }), notes('Use @Gotham Bold', 2, 'job7'));
    await prepareFontRefs(options({ publish }), notes('Use @Gotham Bold', 1, 'job8'));

    expect(
      repo
        .openRequests(0)
        .map((request) => `${request.jobId}/${request.round}`)
        .sort(),
    ).toEqual(['job7/1', 'job7/2', 'job8/1']);
    expect(published).toHaveLength(3);
  });

  it('asks again once the earlier request was answered by an import', async () => {
    const run = () => prepareFontRefs(options({ publish }), notes('Use @Gotham Bold', 1, 'job7'));
    await run();
    repo.resolveRequests('Gotham Bold');
    await run();

    expect(rawRow(db, 'font_requests')).toHaveLength(2);
    expect(published).toHaveLength(2);
  });

  it('a name dismissed with "Not a font" is not written or told again in a later round, but the run is still told the name (C52)', async () => {
    const first = await prepareFontRefs(
      options({ publish }),
      notes('Send it to @Falcon', 0, 'job7'),
    );
    const [request] = repo.openRequests(0);
    expect(first?.unresolved).toEqual(['Falcon']);
    repo.dismissRequest(request?.id ?? '');
    published.length = 0;

    const later = await prepareFontRefs(
      options({ publish }),
      notes('Send it to @Falcon', 2, 'job7'),
    );
    const retry = await prepareFontRefs(
      options({ publish }),
      notes('Send it to @Falcon', 0, 'job7'),
    );

    // The edit's prompt line is as it was: the run still hears that the library lacks the name.
    expect(later?.unresolved).toEqual(['Falcon']);
    expect(retry?.unresolved).toEqual(['Falcon']);
    expect(rawRow(db, 'font_requests')).toHaveLength(1);
    expect(repo.openRequests(0)).toEqual([]);
    expect(published).toEqual([]);

    // Another job that writes the word is its own request.
    await prepareFontRefs(options({ publish }), notes('Send it to @Falcon', 0, 'job8'));
    expect(repo.openRequests(0).map((open) => open.jobId)).toEqual(['job8']);
    expect(published).toHaveLength(1);
  });

  it('a note that names only fonts that are there, or none, writes no request', async () => {
    await prepareFontRefs(options({ publish }), notes('Captions in @Outfit'));
    await prepareFontRefs(options({ publish }), notes('make it shorter'));
    await prepareFontRefs(options({ publish }), notes('mail me@Example.com'));

    expect(rawRow(db, 'font_requests')).toEqual([]);
    expect(published).toEqual([]);
  });

  it('works without anybody to tell', async () => {
    await prepareFontRefs(options(), notes('Use @Gotham Bold'));
    expect(rawRow(db, 'font_requests')).toHaveLength(1);
  });

  it('a request that cannot be written is logged and the run still gets the answer', async () => {
    const broken = {
      recordRequest() {
        throw new Error('database is locked');
      },
    };
    const answer = await prepareFontRefs(
      options({ requests: broken, publish }),
      notes('Captions in @Gotham Bold and @Outfit'),
    );

    expect(answer).toEqual({
      fonts: [expect.objectContaining({ face: 'Outfit' })],
      unresolved: ['Gotham Bold'],
    });
    expect(published).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ font: 'Gotham Bold' }),
      expect.stringContaining('could not write down a missing font'),
    );
  });

  it('a listener that throws does not fail the run either', async () => {
    const answer = await prepareFontRefs(
      options({
        publish: () => {
          throw new Error('nobody home');
        },
      }),
      notes('Use @Gotham Bold'),
    );
    expect(answer).toEqual({ fonts: [], unresolved: ['Gotham Bold'] });
    expect(warn).toHaveBeenCalled();
  });
});

describe('the job’s copy of the file', () => {
  it('a font imported after the edit began is copied into the job, at the same path, whole', async () => {
    library.putFixture(OUTFIT_BOLD, 'Outfit-Bold.ttf');
    await index.refresh();
    expect(existsSync(jobFont(OUTFIT_BOLD))).toBe(false);

    const answer = await prepareFontRefs(options(), notes('Captions in @Outfit Bold', 1));

    expect(answer?.fonts).toEqual([
      expect.objectContaining({ face: 'Outfit Bold', path: `edit/fonts/${OUTFIT_BOLD}` }),
    ]);
    expect(readFileSync(jobFont(OUTFIT_BOLD))).toEqual(
      readFileSync(join(FIXTURE_FONTS, 'Outfit-Bold.ttf')),
    );
    // No temp file is left next to it, and the other fonts of the job are as they were.
    expect(readdirSync(join(jobDir, 'edit', 'fonts', 'English only', 'Outfit')).sort()).toEqual([
      'Outfit-Bold.ttf',
      'Outfit-Regular.ttf',
    ]);
    expect(rawRow(db, 'font_uses')).toHaveLength(1);
  });

  it('keeps the copy the job already has', async () => {
    writeFileSync(jobFont(OUTFIT), 'the job’s own copy');
    await prepareFontRefs(options(), notes('Titles in @Outfit'));
    expect(readFileSync(jobFont(OUTFIT), 'utf8')).toBe('the job’s own copy');
  });

  it('a font whose file is gone from both is not told, not counted, and logged', async () => {
    library.putFixture(OUTFIT_BOLD, 'Outfit-Bold.ttf');
    await index.refresh();
    library.remove(OUTFIT_BOLD);

    const answer = await prepareFontRefs(
      options(),
      notes('Captions in @Outfit Bold, titles in @Bellefair'),
    );

    expect(answer?.fonts.map((font) => font.face)).toEqual(['Bellefair']);
    expect(rawRow(db, 'font_uses')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ font: 'Outfit Bold' }),
      expect.stringContaining('could not put a font'),
    );
    expect(existsSync(jobFont(OUTFIT_BOLD))).toBe(false);
  });

  it('never leaves the fonts folder: a path with .. is refused', async () => {
    const odd: FontCatalog = {
      faces: [
        {
          name: 'Odd',
          family: 'Odd',
          weight: 400,
          italic: false,
          file: '../../outside.ttf',
          he: false,
        },
      ],
    };
    const answer = await prepareFontRefs(options({ catalog: async () => odd }), notes('@Odd'));
    expect(answer).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a use that cannot be counted does not fail the run', async () => {
    const broken = {
      addUse: () => {
        throw new Error('database is locked');
      },
    };
    const answer = await prepareFontRefs(options({ uses: broken }), notes('Titles in @Outfit'));
    expect(answer?.fonts).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ font: 'Outfit' }),
      expect.stringContaining('could not count a font use'),
    );
  });
});

describe('the runner wrapper', () => {
  const seen: (RunContext | undefined)[] = [];
  const inner: Runner = {
    async start(_job, _mode, context) {
      seen.push(context);
      return { ok: true };
    },
  };
  const context = (over: Partial<RunContext> = {}): RunContext => ({
    signal: new AbortController().signal,
    progress: () => {},
    ...over,
  });
  const reviseJob = (over: object = {}) =>
    makeJob({
      relPath: 'Acme/Teaser',
      runKind: 'revise',
      round: 2,
      step: 4,
      id: 'job9',
      ...over,
    });

  beforeEach(() => {
    seen.length = 0;
  });

  function writeRound(text: string): void {
    mkdirSync(join(jobDir, 'edit', 'review'), { recursive: true });
    writeFileSync(join(jobDir, 'edit', 'review', 'round-2.md'), text);
  }

  it('a revise run reads its round file and hands the fonts down on the context', async () => {
    writeRound('# Review notes, round 2\n\n- 0:03.0: captions in @Bellefair, titles in @Outfit\n');

    const outcome = await withFontRefs(inner, options()).start(reviseJob(), 'start', context());

    expect(outcome.ok).toBe(true);
    expect(seen[0]?.libraryRefs).toEqual({
      luts: [],
      graphics: [],
      missing: [],
      fonts: [
        expect.objectContaining({ face: 'Bellefair', path: `edit/fonts/${BELLEFAIR}` }),
        expect.objectContaining({ face: 'Outfit' }),
      ],
    });
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({ job_id: 'job9', round: 2, source: 'token' }),
      expect.objectContaining({ job_id: 'job9', round: 2, source: 'token' }),
    ]);
  });

  it('an edit run reads the job’s note, at round 0', async () => {
    await withFontRefs(inner, options()).start(
      makeJob({
        relPath: 'Acme/Teaser',
        runKind: 'edit',
        round: 0,
        step: 1,
        id: 'job8',
        note: 'Everything in @Secular One',
      }),
      'start',
      context(),
    );
    expect(seen[0]?.libraryRefs?.fonts?.map((font) => font.face)).toEqual(['Secular One']);
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({ job_id: 'job8', round: 0 }),
    ]);
  });

  it('adds the fonts to the references an outer wrapper put there, and keeps them', async () => {
    writeRound('- 0:01.0: @Outfit please\n');
    const lut = {
      slug: 'golden-hour',
      name: 'Golden Hour',
      kind: 'look' as const,
      owner: 'yours' as const,
      path: 'edit/luts/golden-hour.cube',
      look: null,
    };
    const before: RunLibraryRefs = {
      luts: [lut],
      graphics: [],
      missing: [{ library: 'luts', slug: 'zzz', reason: 'notInLibrary' }],
      // The camera-log answer of an edit run (LU10) rides along too.
      camera: { curves: [], byNote: false },
    };

    await withFontRefs(inner, options()).start(
      reviseJob(),
      'start',
      context({ libraryRefs: before }),
    );

    expect(seen[0]?.libraryRefs).toEqual({
      ...before,
      fonts: [expect.objectContaining({ face: 'Outfit' })],
    });
    // The context it was given is not changed.
    expect(before).not.toHaveProperty('fonts');
  });

  it('puts a missing font name on the context (the prompt tells it), tells no font, and writes the request', async () => {
    writeRound('- 0:01.0: use @Gotham Bold\n');
    await withFontRefs(inner, options()).start(reviseJob(), 'start', context());
    expect(seen[0]?.libraryRefs).toEqual({
      luts: [],
      graphics: [],
      missing: [],
      unresolvedFonts: ['Gotham Bold'],
    });
    // The request is the job's (its id), in the round of the notes (round 2 here).
    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ name: 'Gotham Bold', job_id: 'job9', round: 2, resolved_at: null }),
    ]);
  });

  it('a run started again for the same round (a retry) asks once', async () => {
    writeRound('- 0:01.0: use @Gotham Bold\n');
    const wrapped = withFontRefs(inner, options());
    await wrapped.start(reviseJob(), 'start', context());
    await wrapped.start(reviseJob(), 'retry', context());
    await wrapped.start(reviseJob(), 'resume', context());
    expect(rawRow(db, 'font_requests')).toHaveLength(1);
    expect(seen.map((one) => one?.libraryRefs?.unresolvedFonts)).toEqual([
      ['Gotham Bold'],
      ['Gotham Bold'],
      ['Gotham Bold'],
    ]);
  });

  it('gives a note that names nothing the context it always had', async () => {
    writeRound('- 0:01.0: make it shorter\n');
    const given = context();
    await withFontRefs(inner, options()).start(reviseJob(), 'start', given);
    expect(seen[0]).toBe(given);
    expect(seen[0]?.libraryRefs).toBeUndefined();
  });

  it('leaves a render run alone: it renders what was approved', async () => {
    writeRound('- 0:01.0: @Outfit\n');
    const given = context();
    await withFontRefs(inner, options()).start(
      makeJob({ relPath: 'Acme/Teaser', runKind: 'render', round: 2 }),
      'start',
      given,
    );
    expect(seen[0]).toBe(given);
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });

  it('a missing round file or a library that cannot be read only costs the run its fonts', async () => {
    const given = context();
    // No round file at all.
    await withFontRefs(inner, options()).start(reviseJob(), 'start', given);
    expect(seen[0]).toBe(given);

    writeRound('- 0:01.0: @Outfit\n');
    const broken = options({
      catalog: async () => {
        throw new Error('the index is not there');
      },
    });
    const outcome = await withFontRefs(inner, broken, logger).start(reviseJob(), 'start', given);
    expect(outcome.ok).toBe(true);
    expect(seen[1]).toBe(given);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job9' }),
      expect.stringContaining('could not look at the font tokens'),
    );
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });
});

// A quick fix in Review looks for the font a note names in the job's edit/fonts/. A job whose edit
// began before the library had the font (or before there was a library) has no copy, which is how a
// fix said "edit/fonts is missing" for a note asking for @Rubik Glitch.
describe('the quick fix wrapper', () => {
  const FIXED: QuickFixOutcome = { status: 'fixed', said: 'Done.', hasCompare: false };
  /** What was in the job's edit/fonts/ when the inner run started, per run. */
  const seen: { fonts: boolean; outfit: boolean }[] = [];
  const inner: QuickFixRunner = {
    kind: 'claude',
    async run() {
      seen.push({
        fonts: existsSync(join(jobDir, 'edit', 'fonts')),
        outfit: existsSync(jobFont(OUTFIT)),
      });
      return FIXED;
    },
  };
  const request = (text: string | null, round = 5): QuickFixRequest => ({
    job: { id: 'job9', client: 'Acme', name: 'Teaser', relPath: 'Acme/Teaser' },
    note: { id: 'note1', atSec: 3.4, text, route: null },
    fix: { id: 'fix1', round },
    signal: new AbortController().signal,
  });

  beforeEach(() => {
    seen.length = 0;
    // An older job: its edit began before there was a font to copy.
    rmSync(join(jobDir, 'edit', 'fonts'), { recursive: true, force: true });
  });

  it('puts the font the note names in the job before the fix starts, and counts the use for its round', async () => {
    const outcome = await withQuickFixFonts(inner, options()).run(
      request('change all subtitle fonts to @Outfit'),
    );

    expect(outcome).toEqual(FIXED);
    expect(seen).toEqual([{ fonts: true, outfit: true }]);
    expect(readFileSync(jobFont(OUTFIT)).length).toBeGreaterThan(0);
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({ family: 'Outfit', job_id: 'job9', round: 5, source: 'token' }),
    ]);
  });

  it('copies only the file the note names, not the whole library', async () => {
    await withQuickFixFonts(inner, options()).run(request('captions in @Outfit'));

    expect(existsSync(jobFont(OUTFIT))).toBe(true);
    expect(existsSync(jobFont(BELLEFAIR))).toBe(false);
  });

  it('leaves a job that already has the file alone', async () => {
    await copySharedFonts(library.inbox, jobDir);
    const before = readFileSync(jobFont(OUTFIT));

    await withQuickFixFonts(inner, options()).run(request('captions in @Outfit'));

    expect(readFileSync(jobFont(OUTFIT)).equals(before)).toBe(true);
    expect(seen).toEqual([{ fonts: true, outfit: true }]);
  });

  it.each([
    ['a note that names nothing', 'make the title bigger'],
    ['a voice note with no transcript', null],
    ['an @ that is not a font', 'mail a@example.com about it'],
  ])('does not touch the job for %s', async (_name, text) => {
    const catalog = vi.fn(async () => index.catalog());

    const outcome = await withQuickFixFonts(inner, options({ catalog })).run(request(text));

    expect(outcome).toEqual(FIXED);
    expect(seen).toEqual([{ fonts: false, outfit: false }]);
    expect(rawRow(db, 'font_uses')).toEqual([]);
    if (text === null || !text.includes('@')) expect(catalog).not.toHaveBeenCalled();
  });

  it('writes down a name the library lacks for the Fonts page, and still runs the fix', async () => {
    const outcome = await withQuickFixFonts(inner, options()).run(request('use @Gotham Bold', 5));

    expect(outcome).toEqual(FIXED);
    expect(seen).toHaveLength(1);
    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ name: 'Gotham Bold', job_id: 'job9', round: 5, resolved_at: null }),
    ]);
  });

  it('a library that cannot be read only costs the font: it is logged and the fix still runs', async () => {
    const broken = options({
      catalog: async () => {
        throw new Error('the index is not there');
      },
    });

    const outcome = await withQuickFixFonts(inner, broken, logger).run(
      request('captions in @Outfit'),
    );

    expect(outcome).toEqual(FIXED);
    expect(seen).toEqual([{ fonts: false, outfit: false }]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job9' }),
      expect.stringContaining('could not look at the font tokens of the note'),
    );
  });

  it('is the runner it wraps, as far as the fix service can tell', async () => {
    expect(withQuickFixFonts(inner, options()).kind).toBe('claude');
    const failed: QuickFixOutcome = { status: 'failed', why: 'it crashed', hasCompare: false };
    const crashing: QuickFixRunner = { kind: 'fake', run: async () => failed };
    const wrapped = withQuickFixFonts(crashing, options());
    expect(wrapped.kind).toBe('fake');
    expect(await wrapped.run(request('captions in @Outfit'))).toEqual(failed);
  });
});

// The fake runner is what development and the e2e run use: a revise round that names a font must
// still complete, and what the real runner would have been told is written to
// edit/library-refs.json. Needs ffmpeg (the fake runner makes its test videos with it).
describe.skipIf(!hasFfmpeg())('through the fake runner', () => {
  const FAST = 100_000;

  function fake() {
    return new FakeRunner({
      inboxPath: library.inbox,
      speed: FAST,
      clipSeconds: 0.5,
      review: true,
    });
  }
  const context = (): RunContext => ({ signal: new AbortController().signal, progress: () => {} });
  const written = () =>
    JSON.parse(readFileSync(join(jobDir, 'edit', LIBRARY_REFS_FILE), 'utf8')) as RunLibraryRefs;

  beforeEach(() => {
    for (const file of ['clip-01.mp4', 'voice.m4a']) writeFileSync(join(jobDir, file), '');
  });

  it('a revise round that names a font completes, is told the font and counts the use', async () => {
    await writeFakePreview(join(jobDir, 'edit'), 'Teaser');
    writeFileSync(
      join(jobDir, 'edit', 'project.md'),
      '# Acme: Teaser\n\n## Session 1\n\nThe plan.\n',
    );
    mkdirSync(join(jobDir, 'edit', 'review'), { recursive: true });
    writeFileSync(
      join(jobDir, 'edit', 'review', 'round-2.md'),
      '# Review notes, round 2\n\n- 0:03.0: the titles in @Bellefair, and @Gotham Bold for the end\n',
    );

    const outcome = await withFontRefs(fake(), options()).start(
      makeJob({ relPath: 'Acme/Teaser', runKind: 'revise', round: 2, step: 4, id: 'job9' }),
      'start',
      context(),
    );

    expect(outcome.ok).toBe(true);
    expect(written()).toEqual({
      luts: [],
      graphics: [],
      missing: [],
      fonts: [
        {
          face: 'Bellefair',
          family: 'Bellefair',
          weight: 400,
          italic: false,
          path: `edit/fonts/${BELLEFAIR}`,
          he: true,
        },
      ],
      unresolvedFonts: ['Gotham Bold'],
    });
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({
        family: 'Bellefair',
        job_id: 'job9',
        round: 2,
        source: 'token',
      }),
    ]);
    // The missing name is only written down: the round did not wait and did not fail.
    expect(rawRow(db, 'font_requests')).toEqual([
      expect.objectContaining({ name: 'Gotham Bold', job_id: 'job9', round: 2 }),
    ]);
  });

  it('an edit run whose note names a font is told too, at round 0', async () => {
    const outcome = await withFontRefs(fake(), options()).start(
      makeJob({
        relPath: 'Acme/Teaser',
        runKind: 'edit',
        round: 0,
        step: 1,
        id: 'job8',
        note: 'Everything in @Secular One',
      }),
      'start',
      context(),
    );
    expect(outcome.ok).toBe(true);
    expect(written().fonts?.map((font) => font.face)).toEqual(['Secular One']);
    expect(rawRow(db, 'font_uses')).toEqual([
      expect.objectContaining({ family: 'Secular One', job_id: 'job8', round: 0 }),
    ]);
    expect(existsSync(join(jobDir, 'edit', 'preview', 'index.html'))).toBe(true);
  });

  it('with the switch off (no wrapper) a note’s @ token changes nothing', async () => {
    const outcome = await fake().start(
      makeJob({ relPath: 'Acme/Teaser', runKind: 'edit', step: 1, note: '@Secular One' }),
      'start',
      context(),
    );
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(jobDir, 'edit', LIBRARY_REFS_FILE))).toBe(false);
    expect(rawRow(db, 'font_uses')).toEqual([]);
  });
});
