import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LutChangedEvent } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { GraphicRepository } from '../db/graphic-repository.js';
import { LutRepository } from '../db/lut-repository.js';
import { fakeClock, memoryDb, rawRow } from '../db/test-utils.js';
import { makeJob } from '../events/test-utils.js';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import { FakeRunner, LIBRARY_REFS_FILE } from '../pipeline/fake-runner.js';
import type { RunContext, RunLibraryRefs, Runner } from '../pipeline/runner.js';
import { createBuiltInLuts } from './lut-builtin.js';
import {
  countUses,
  EDIT_LUTS_DIR,
  type LutJobFilesOptions,
  lutRunNotes,
  type PendingLutUse,
  prepareLutJobFiles,
  withLutRefs,
} from './lut-job-files.js';
import { cubeText, hasFfmpeg, identity, invert, writeFakeSkill } from './lut-test-utils.js';

// LU9: the job's copy of the LUTs its notes name, the uses it counts and the answer the run is
// told. Real files in a temp inbox, a real repository on an in-memory database, the real built-in
// catalog over a stand-in skill folder.

const dirs: string[] = [];
let root: string;
let inbox: string;
let jobDir: string;
let skill: string;
let db: StudioDb;
let repo: LutRepository;
let graphicsRepo: GraphicRepository;
let events: LutChangedEvent[];
const warn = vi.fn();
const logger = { info: vi.fn(), warn, error: vi.fn() };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-lut-job-'));
  dirs.push(root);
  inbox = join(root, 'inbox');
  jobDir = join(inbox, 'Acme', 'Teaser');
  skill = writeFakeSkill(join(root, 'skill'));
  mkdirSync(join(jobDir, 'edit'), { recursive: true });
  mkdirSync(join(inbox, '_LUTs'), { recursive: true });
  db = memoryDb();
  repo = new LutRepository(db, { clock: fakeClock() });
  graphicsRepo = new GraphicRepository(db, { clock: fakeClock() });
  events = [];
  warn.mockClear();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A LUT of Yours: its file in `_LUTs` and its row. */
function addYours(
  name: string,
  kind: 'look' | 'camera' | 'fix' = 'look',
  text = cubeText(5, invert),
) {
  const file = `${name}.cube`;
  writeFileSync(join(inbox, '_LUTs', file), text);
  return repo.create({
    name,
    kind,
    size: 5,
    file,
    bytes: Buffer.byteLength(text),
    sha256: 'a'.repeat(64),
    sourceName: file,
  });
}

function options(over: Partial<LutJobFilesOptions> = {}): LutJobFilesOptions {
  return {
    luts: repo,
    builtIn: createBuiltInLuts({ skillDir: skill, dataDir: join(root, 'data') }),
    inboxPath: inbox,
    publish: (event) => events.push(event),
    logger,
    ...over,
  };
}

const notes = (text: string, round = 0, jobId = 'job1') => ({
  jobId,
  jobDir,
  round,
  texts: [text],
});

/** The files handed to a run whose notes are `n`, and the run then succeeds: the uses are counted. */
async function handedAndCounted(opts: LutJobFilesOptions, n: ReturnType<typeof notes>) {
  const pending: PendingLutUse[] = [];
  const answer = await prepareLutJobFiles(opts, n, pending);
  await countUses(opts, n.jobId, pending);
  return answer;
}

const lutFile = (slug: string) => join(jobDir, EDIT_LUTS_DIR, `${slug}.cube`);

describe('a note that names nothing', () => {
  it.each([
    'Make it brighter and cut the intro',
    '',
    'mail me at a@luts/golden-hour-warm.com',
    'caps @luts/Golden-Hour',
  ])('leaves the job alone: %j', async (text) => {
    addYours('Golden Hour');
    expect(await handedAndCounted(options(), notes(text))).toBeNull();
    expect(existsSync(join(jobDir, EDIT_LUTS_DIR))).toBe(false);
    expect(rawRow(db, 'lut_uses')).toEqual([]);
  });
});

describe('a LUT of Yours', () => {
  it('is copied whole into edit/luts/<slug>.cube, counted by its id, and the run is told', async () => {
    const lut = addYours('Golden Hour', 'look', cubeText(5, invert));
    const answer = await handedAndCounted(
      options(),
      notes('Use @luts/golden-hour for the whole video'),
    );

    expect(answer).toEqual({
      luts: [
        {
          slug: 'golden-hour',
          name: 'Golden Hour',
          kind: 'look',
          owner: 'yours',
          path: 'edit/luts/golden-hour.cube',
          look: null,
        },
      ],
      graphics: [],
      missing: [],
    });
    expect(readFileSync(lutFile('golden-hour'), 'utf8')).toBe(cubeText(5, invert));
    expect(repo.usedCount(lut.id)).toBe(1);
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ lut_key: lut.id, job_id: 'job1', round: 0 }),
    ]);
    // The list's "Used" moved: its summary goes out again.
    expect(events).toHaveLength(1);
    expect(events[0]?.lut).toMatchObject({ slug: 'golden-hour', owner: 'yours', used: 1 });
  });

  it('replaces a stale copy, and counts a round once however often it starts', async () => {
    const lut = addYours('Golden Hour');
    mkdirSync(join(jobDir, EDIT_LUTS_DIR), { recursive: true });
    writeFileSync(lutFile('golden-hour'), 'an old copy of something else');

    await handedAndCounted(options(), notes('@luts/golden-hour'));
    expect(readFileSync(lutFile('golden-hour'), 'utf8')).toBe(cubeText(5, invert));

    // The file in the library changed (re-imported under the same name): the next run gets it.
    writeFileSync(join(inbox, '_LUTs', 'Golden Hour.cube'), cubeText(5, identity));
    await handedAndCounted(options(), notes('@luts/golden-hour'));
    expect(readFileSync(lutFile('golden-hour'), 'utf8')).toBe(cubeText(5, identity));

    expect(repo.usedCount(lut.id)).toBe(1);
    expect(rawRow(db, 'lut_uses')).toHaveLength(1);
    expect(events).toHaveLength(1); // told once: the second run changed no count
    // No half-written copy is left behind.
    expect(readdirSync(join(jobDir, EDIT_LUTS_DIR))).toEqual(['golden-hour.cube']);
  });

  it('counts each review round of the job on its own, still one job', async () => {
    const lut = addYours('Golden Hour');
    await handedAndCounted(options(), notes('@luts/golden-hour', 0));
    await handedAndCounted(options(), notes('@luts/golden-hour', 1));
    await handedAndCounted(options(), notes('@luts/golden-hour', 2));
    expect(rawRow(db, 'lut_uses')).toHaveLength(3);
    expect(repo.usedCount(lut.id)).toBe(1); // distinct jobs
    await handedAndCounted(options(), notes('@luts/golden-hour', 0, 'job2'));
    expect(repo.usedCount(lut.id)).toBe(2);
  });

  it('a Camera LUT and a Fix LUT keep their kind', async () => {
    addYours('Camera A', 'camera');
    addYours('Skin Fix', 'fix');
    const answer = await handedAndCounted(options(), notes('@luts/skin-fix then @luts/camera-a'));
    expect(answer?.luts.map((lut) => [lut.slug, lut.kind])).toEqual([
      ['skin-fix', 'fix'],
      ['camera-a', 'camera'],
    ]);
  });

  it('names each once, in the order the text first names them', async () => {
    addYours('One');
    addYours('Two');
    addYours('Three');
    const answer = await handedAndCounted(
      options(),
      notes('@luts/three, @luts/one, @luts/three again, then @luts/two and @luts/one'),
    );
    expect(answer?.luts.map((lut) => lut.slug)).toEqual(['three', 'one', 'two']);
    expect(readdirSync(join(jobDir, EDIT_LUTS_DIR)).sort()).toEqual([
      'one.cube',
      'three.cube',
      'two.cube',
    ]);
  });

  it('a file that left _LUTs is reported missing, not fatal, not counted; the others still go', async () => {
    const gone = addYours('Gone');
    addYours('Here');
    rmSync(join(inbox, '_LUTs', 'Gone.cube'));
    const answer = await handedAndCounted(options(), notes('@luts/gone @luts/here'));
    expect(answer?.luts.map((lut) => lut.slug)).toEqual(['here']);
    expect(answer?.missing).toEqual([{ library: 'luts', slug: 'gone', reason: 'noFile' }]);
    expect(repo.usedCount(gone.id)).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(existsSync(lutFile('gone'))).toBe(false);
    expect(readdirSync(join(jobDir, EDIT_LUTS_DIR))).toEqual(['here.cube']);
  });

  it('a deleted LUT and a misspelled token are not in the library', async () => {
    const lut = addYours('Old Look');
    repo.softDelete(lut.id);
    const answer = await handedAndCounted(options(), notes('@luts/old-look and @luts/xyz'));
    expect(answer).toEqual({
      luts: [],
      graphics: [],
      missing: [
        { library: 'luts', slug: 'old-look', reason: 'notInLibrary' },
        { library: 'luts', slug: 'xyz', reason: 'notInLibrary' },
      ],
    });
    expect(existsSync(join(jobDir, EDIT_LUTS_DIR))).toBe(false);
    expect(repo.usedCount(lut.id)).toBe(0);
  });
});

describe('the built-in LUTs', () => {
  it('a file one is copied from the skill and counted by its slug', async () => {
    const answer = await handedAndCounted(options(), notes('Fix the skin with @luts/red-skin-fix'));
    expect(answer?.luts).toEqual([
      {
        slug: 'red-skin-fix',
        name: 'Red skin fix',
        kind: 'fix',
        owner: 'builtIn',
        path: 'edit/luts/red-skin-fix.cube',
        look: null,
      },
    ]);
    expect(readFileSync(lutFile('red-skin-fix'), 'utf8')).toBe(
      readFileSync(join(skill, 'correction_luts', 'red_skin_fix.cube'), 'utf8'),
    );
    expect(repo.usedCounts().get('red-skin-fix')).toBe(1);
    expect(events[0]?.lut).toMatchObject({ slug: 'red-skin-fix', owner: 'builtIn', used: 1 });
  });

  it('Cinematic is the wrapper’s own look: no file is copied, and it counts as cinematic', async () => {
    const answer = await handedAndCounted(options(), notes('make it @luts/cinematic'));
    expect(answer?.luts).toEqual([
      {
        slug: 'cinematic',
        name: 'Cinematic',
        kind: 'look',
        owner: 'builtIn',
        path: null,
        look: 'cinematic',
      },
    ]);
    expect(existsSync(join(jobDir, EDIT_LUTS_DIR))).toBe(false);
    expect(repo.usedCounts().get('cinematic')).toBe(1);
  });

  it('without the colour grade, every built-in token is missing, Cinematic too', async () => {
    const builtIn = createBuiltInLuts({ skillDir: join(root, 'no-skill'), dataDir: root });
    const answer = await handedAndCounted(
      options({ builtIn }),
      notes('@luts/cinematic @luts/red-skin-fix'),
    );
    expect(answer).toEqual({
      luts: [],
      graphics: [],
      missing: [
        { library: 'luts', slug: 'cinematic', reason: 'notInLibrary' },
        { library: 'luts', slug: 'red-skin-fix', reason: 'notInLibrary' },
      ],
    });
    expect(repo.usedCounts().size).toBe(0);
  });

  it('a built-in file that is missing from the skill is reported missing', async () => {
    writeFakeSkill(join(root, 'skill-two'), ['red_skin_fix.cube']);
    // available() is false when any file is missing: every built-in token is then missing.
    const builtIn = createBuiltInLuts({ skillDir: join(root, 'skill-two'), dataDir: root });
    const answer = await handedAndCounted(options({ builtIn }), notes('@luts/led-green-fix'));
    expect(answer?.missing).toEqual([
      { library: 'luts', slug: 'led-green-fix', reason: 'notInLibrary' },
    ]);
  });

  it('a built-in LUT whose cubePath fails mid-run is reported as missing a file, not fatal', async () => {
    const real = createBuiltInLuts({ skillDir: skill, dataDir: root });
    const builtIn = {
      available: real.available,
      list: real.list,
      cubePath: async () => {
        throw new Error('disk gone');
      },
    };
    const answer = await handedAndCounted(options({ builtIn }), notes('@luts/led-green-fix'));
    expect(answer).toEqual({
      luts: [],
      graphics: [],
      missing: [{ library: 'luts', slug: 'led-green-fix', reason: 'noFile' }],
    });
    expect(repo.usedCounts().size).toBe(0);
  });
});

describe('graphics named in a note', () => {
  function addGraphic(name: string, { copied = true } = {}) {
    const graphic = graphicsRepo.create({ name });
    graphicsRepo.setVersion(graphic.id, { version: 1 });
    if (copied) mkdirSync(join(jobDir, 'edit', 'graphics', graphic.id), { recursive: true });
    return graphic;
  }

  it('one the job has a copy of is named, with where the copy is', async () => {
    const graphic = addGraphic('Intro');
    const answer = await handedAndCounted(
      options({ graphics: graphicsRepo }),
      notes('put @graphics/intro at 0:05'),
    );
    expect(answer).toEqual({
      luts: [],
      graphics: [
        { slug: 'intro', id: graphic.id, name: 'Intro', path: `edit/graphics/${graphic.id}` },
      ],
      missing: [],
    });
    expect(rawRow(db, 'lut_uses')).toEqual([]);
  });

  it('one the job has no copy of (its "Edits can use it" was off) is not in the job', async () => {
    addGraphic('Outro', { copied: false });
    const answer = await handedAndCounted(
      options({ graphics: graphicsRepo }),
      notes('@graphics/outro'),
    );
    expect(answer).toEqual({
      luts: [],
      graphics: [],
      missing: [{ library: 'graphics', slug: 'outro', reason: 'notInJob' }],
    });
  });

  it('a graphic that is not in the library is missing', async () => {
    const answer = await handedAndCounted(
      options({ graphics: graphicsRepo }),
      notes('@graphics/nothing'),
    );
    expect(answer?.missing).toEqual([
      { library: 'graphics', slug: 'nothing', reason: 'notInLibrary' },
    ]);
  });

  it('while edits do not use the Graphics library a graphics token is not the run’s business', async () => {
    addGraphic('Intro');
    expect(await handedAndCounted(options(), notes('@graphics/intro @graphics/zzz'))).toBeNull();
    const withLut = await handedAndCounted(options(), notes('@graphics/intro @luts/cinematic'));
    expect(withLut?.graphics).toEqual([]);
    expect(withLut?.missing).toEqual([]);
    expect(withLut?.luts.map((lut) => lut.slug)).toEqual(['cinematic']);
  });
});

describe('which text is the run’s notes', () => {
  const note = (over: object) => makeJob({ relPath: 'Acme/Teaser', ...over });

  it('an edit run reads the job’s note, trimmed', async () => {
    expect(
      await lutRunNotes(note({ runKind: 'edit', note: '  @luts/cinematic please \n' }), jobDir),
    ).toEqual({
      jobId: 'a1b2c3d4e5f6',
      jobDir,
      round: 0,
      texts: ['@luts/cinematic please'],
    });
    expect(await lutRunNotes(note({ runKind: 'edit', note: null }), jobDir)).toBeNull();
    expect(await lutRunNotes(note({ runKind: 'edit', note: '   ' }), jobDir)).toBeNull();
  });

  it('a revise run reads edit/review/round-N.md for its round', async () => {
    mkdirSync(join(jobDir, 'edit', 'review'), { recursive: true });
    writeFileSync(
      join(jobDir, 'edit', 'review', 'round-2.md'),
      '# Review notes\n- 0:05 @luts/cinematic\n',
    );
    writeFileSync(join(jobDir, 'edit', 'review', 'round-1.md'), 'nothing here');
    const found = await lutRunNotes(
      note({ runKind: 'revise', round: 2, note: '@luts/other' }),
      jobDir,
    );
    expect(found).toEqual({
      jobId: 'a1b2c3d4e5f6',
      jobDir,
      round: 2,
      texts: ['# Review notes\n- 0:05 @luts/cinematic\n'],
    });
    // The job's own note is not read again in a revise round.
    expect(found?.texts.join('')).not.toContain('@luts/other');
    expect(await lutRunNotes(note({ runKind: 'revise', round: 3 }), jobDir)).toBeNull();
  });

  it('a render run edits nothing: no text', async () => {
    expect(
      await lutRunNotes(note({ runKind: 'render', note: '@luts/cinematic' }), jobDir),
    ).toBeNull();
  });
});

describe('withLutRefs', () => {
  function recorder() {
    const seen: RunContext[] = [];
    const runner: Runner = {
      async start(_job, _mode, context) {
        seen.push(context);
        return { ok: true };
      },
    };
    return { seen, runner };
  }
  const context = (): RunContext => ({ signal: new AbortController().signal, progress: () => {} });
  const job = (over: object) => makeJob({ relPath: 'Acme/Teaser', ...over });

  it('puts the answer on the context of an edit run and keeps the rest of it', async () => {
    addYours('Golden Hour');
    const { seen, runner } = recorder();
    const given = context();
    const outcome = await withLutRefs(runner, options()).start(
      job({ runKind: 'edit', note: 'try @luts/golden-hour' }),
      'start',
      given,
    );
    expect(outcome).toEqual({ ok: true });
    const refs = seen[0]?.libraryRefs as RunLibraryRefs;
    expect(refs.luts.map((lut) => lut.slug)).toEqual(['golden-hour']);
    expect(seen[0]?.signal).toBe(given.signal);
    expect(seen[0]?.progress).toBe(given.progress);
    expect(existsSync(lutFile('golden-hour'))).toBe(true);
  });

  it('gives a run whose notes name nothing the very context it got', async () => {
    const { seen, runner } = recorder();
    const given = context();
    await withLutRefs(runner, options()).start(
      job({ runKind: 'edit', note: 'cut the intro' }),
      'start',
      given,
    );
    await withLutRefs(runner, options()).start(
      job({ runKind: 'edit', note: null }),
      'start',
      given,
    );
    await withLutRefs(runner, options()).start(
      job({ runKind: 'render', note: '@luts/cinematic' }),
      'start',
      given,
    );
    expect(seen).toEqual([given, given, given]);
    expect(seen[0]).toBe(given);
  });

  it('a revise run gets the round file’s tokens', async () => {
    addYours('Golden Hour');
    mkdirSync(join(jobDir, 'edit', 'review'), { recursive: true });
    writeFileSync(
      join(jobDir, 'edit', 'review', 'round-1.md'),
      '- 0:03 grade it @luts/golden-hour\n',
    );
    const { seen, runner } = recorder();
    await withLutRefs(runner, options()).start(
      job({ runKind: 'revise', round: 1 }),
      'start',
      context(),
    );
    expect(seen[0]?.libraryRefs?.luts.map((lut) => lut.slug)).toEqual(['golden-hour']);
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ job_id: 'a1b2c3d4e5f6', round: 1 }),
    ]);
  });

  it('never fails a run: an error is logged and the run starts without references', async () => {
    const { seen, runner } = recorder();
    const broken = options({
      luts: {
        ...repo,
        list: () => {
          throw new Error('database is locked');
        },
      } as unknown as LutRepository,
    });
    const given = context();
    const outcome = await withLutRefs(runner, broken, logger).start(
      job({ runKind: 'edit', note: '@luts/cinematic' }),
      'start',
      given,
    );
    expect(outcome).toEqual({ ok: true });
    expect(seen).toEqual([given]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'a1b2c3d4e5f6' }),
      'could not look at the library tokens of the notes',
    );
  });

  it('hands on the wrapped runner’s own outcome, failure included', async () => {
    const runner: Runner = { start: async () => ({ ok: false, error: 'Preview failed' }) };
    expect(
      await withLutRefs(runner, options()).start(
        job({ runKind: 'edit', note: '@luts/cinematic' }),
        'start',
        context(),
      ),
    ).toEqual({ ok: false, error: 'Preview failed' });
  });
});

describe('a use is counted only when the run succeeded (C54)', () => {
  const context = (): RunContext => ({ signal: new AbortController().signal, progress: () => {} });
  const job = (over: object = {}) =>
    makeJob({
      relPath: 'Acme/Teaser',
      id: 'job1',
      runKind: 'edit',
      note: '@luts/golden-hour',
      ...over,
    });
  const lutEvents = () => events.filter((event) => event.type === 'lut.changed');
  /** A runner that ends the way the queue gives it: failing before editing, or succeeding. */
  const runnerOf = (outcomes: (() => ReturnType<Runner['start']>)[]): Runner => ({
    start: async () => (outcomes.shift() as () => ReturnType<Runner['start']>)(),
  });
  const fails = async () => ({ ok: false as const, error: 'Usage limit reached' });
  const works = async () => ({ ok: true as const });

  it('handing the files over counts nothing by itself', async () => {
    addYours('Golden Hour');
    const pending: PendingLutUse[] = [];
    await prepareLutJobFiles(options(), notes('@luts/golden-hour'), pending);
    expect(existsSync(lutFile('golden-hour'))).toBe(true);
    expect(pending).toHaveLength(1);
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a run that fails before editing: no row, no event, the LUT is still unused', async () => {
    const lut = addYours('Golden Hour');
    const outcome = await withLutRefs(runnerOf([fails]), options()).start(
      job(),
      'start',
      context(),
    );
    expect(outcome).toEqual({ ok: false, error: 'Usage limit reached' });
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    expect(repo.usedCount(lut.id)).toBe(0);
    expect(lutEvents()).toEqual([]);
  });

  it('a runner that throws counts nothing either', async () => {
    addYours('Golden Hour');
    const throwing = runnerOf([
      async () => {
        throw new Error('spawn failed');
      },
    ]);
    await expect(
      withLutRefs(throwing, options()).start(job(), 'start', context()),
    ).rejects.toThrow();
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    expect(lutEvents()).toEqual([]);
  });

  it('a run that succeeds counts once, by id, and sends the fresh summary once', async () => {
    const lut = addYours('Golden Hour');
    await withLutRefs(runnerOf([works]), options()).start(job(), 'start', context());
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ lut_key: lut.id, job_id: 'job1', round: 0 }),
    ]);
    expect(lutEvents()).toHaveLength(1);
    expect(lutEvents()[0]?.lut).toMatchObject({ slug: 'golden-hour', owner: 'yours', used: 1 });
  });

  it('a failed round that is retried and then succeeds counts once', async () => {
    const lut = addYours('Golden Hour');
    const wrapped = withLutRefs(runnerOf([fails, fails, works]), options());
    await wrapped.start(job(), 'start', context());
    await wrapped.start(job(), 'retry', context());
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    expect(lutEvents()).toEqual([]);
    await wrapped.start(job(), 'retry', context());
    expect(rawRow(db, 'lut_uses')).toHaveLength(1);
    expect(repo.usedCount(lut.id)).toBe(1);
    expect(lutEvents()).toHaveLength(1);
  });

  it('the same round succeeding twice (a resume) is still one row and one event', async () => {
    addYours('Golden Hour');
    const wrapped = withLutRefs(runnerOf([works, works]), options());
    await wrapped.start(job(), 'start', context());
    await wrapped.start(job(), 'resume', context());
    expect(rawRow(db, 'lut_uses')).toHaveLength(1);
    expect(lutEvents()).toHaveLength(1);
  });

  it('built-in LUTs and Cinematic count by slug, only on success', async () => {
    const note = '@luts/red-skin-fix and @luts/cinematic';
    await withLutRefs(runnerOf([fails]), options()).start(job({ note }), 'start', context());
    expect(repo.usedCounts().size).toBe(0);
    expect(lutEvents()).toEqual([]);
    await withLutRefs(runnerOf([works]), options()).start(job({ note }), 'retry', context());
    expect(repo.usedCounts().get('red-skin-fix')).toBe(1);
    expect(repo.usedCounts().get('cinematic')).toBe(1);
    expect(lutEvents()).toHaveLength(2);
  });

  it('a revise round counts for its own round, when it succeeds', async () => {
    const lut = addYours('Golden Hour');
    mkdirSync(join(jobDir, 'edit', 'review'), { recursive: true });
    writeFileSync(join(jobDir, 'edit', 'review', 'round-2.md'), '- 0:03: use @luts/golden-hour');
    const revise = job({ runKind: 'revise', round: 2, note: null });
    const wrapped = withLutRefs(runnerOf([fails, works]), options());
    await wrapped.start(revise, 'start', context());
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    await wrapped.start(revise, 'retry', context());
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ lut_key: lut.id, job_id: 'job1', round: 2 }),
    ]);
  });

  it('a count that fails to write is logged and does not change the outcome', async () => {
    addYours('Golden Hour');
    const broken = options({
      luts: {
        list: () => repo.list(),
        usedCount: () => 0,
        usedCounts: () => new Map(),
        addUse: () => {
          throw new Error('disk full');
        },
      },
    });
    const outcome = await withLutRefs(runnerOf([works]), broken).start(job(), 'start', context());
    expect(outcome).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
  });
});

// The whole path with the fake runner: the notes of a revise run (the round file Send writes) and of
// an edit run (the job's note) reach the run, and the fake writes down what it was told, which is
// what an e2e run asserts. Needs ffmpeg (the fake runner makes its test videos with it).
describe.skipIf(!hasFfmpeg())('through the fake runner', () => {
  const FAST = 100_000;

  function fake() {
    return new FakeRunner({ inboxPath: inbox, speed: FAST, clipSeconds: 0.5, review: true });
  }
  const context = (): RunContext => ({ signal: new AbortController().signal, progress: () => {} });
  const written = () =>
    JSON.parse(readFileSync(join(jobDir, 'edit', LIBRARY_REFS_FILE), 'utf8')) as RunLibraryRefs;

  beforeEach(() => {
    for (const file of ['clip-01.mp4', 'voice.m4a']) writeFileSync(join(jobDir, file), '');
  });

  it('a revise round that names a LUT: copied, counted for the round, and told to the run', async () => {
    const lut = addYours('Golden Hour');
    await writeFakePreview(join(jobDir, 'edit'), 'Teaser');
    writeFileSync(
      join(jobDir, 'edit', 'project.md'),
      '# Acme: Teaser\n\n## Session 1\n\nThe plan.\n',
    );
    mkdirSync(join(jobDir, 'edit', 'review'), { recursive: true });
    writeFileSync(
      join(jobDir, 'edit', 'review', 'round-2.md'),
      '# Review notes, round 2\n\n- 0:03.0: grade the whole thing with @luts/golden-hour, and @luts/nope\n',
    );

    const outcome = await withLutRefs(fake(), options()).start(
      makeJob({ relPath: 'Acme/Teaser', runKind: 'revise', round: 2, step: 4, id: 'job9' }),
      'start',
      context(),
    );

    expect(outcome.ok).toBe(true);
    expect(written()).toEqual({
      luts: [
        {
          slug: 'golden-hour',
          name: 'Golden Hour',
          kind: 'look',
          owner: 'yours',
          path: 'edit/luts/golden-hour.cube',
          look: null,
        },
      ],
      graphics: [],
      missing: [{ library: 'luts', slug: 'nope', reason: 'notInLibrary' }],
    });
    expect(readFileSync(lutFile('golden-hour'), 'utf8')).toBe(cubeText(5, invert));
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ lut_key: lut.id, job_id: 'job9', round: 2 }),
    ]);
  });

  it('an edit run whose note names a LUT is told too, at round 0', async () => {
    const lut = addYours('Golden Hour');
    const outcome = await withLutRefs(fake(), options()).start(
      makeJob({
        relPath: 'Acme/Teaser',
        runKind: 'edit',
        round: 0,
        step: 1,
        id: 'job8',
        note: 'Warm it up: @luts/golden-hour',
      }),
      'start',
      context(),
    );
    expect(outcome.ok).toBe(true);
    expect(written().luts.map((entry) => entry.slug)).toEqual(['golden-hour']);
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ lut_key: lut.id, job_id: 'job8', round: 0 }),
    ]);
    // The other files the run leaves are the fake's own.
    expect(existsSync(join(jobDir, 'edit', 'preview', 'index.html'))).toBe(true);
  });

  it('with the switch off (no wrapper) a note’s @luts token changes nothing', async () => {
    addYours('Golden Hour');
    const outcome = await fake().start(
      makeJob({ relPath: 'Acme/Teaser', runKind: 'edit', step: 1, note: '@luts/golden-hour' }),
      'start',
      context(),
    );
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(jobDir, 'edit', LIBRARY_REFS_FILE))).toBe(false);
    expect(existsSync(join(jobDir, EDIT_LUTS_DIR))).toBe(false);
    expect(rawRow(db, 'lut_uses')).toEqual([]);
  });
});
