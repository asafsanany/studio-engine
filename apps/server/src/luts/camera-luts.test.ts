import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LutChangedEvent, parseCameraLutWait } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { LutRepository } from '../db/lut-repository.js';
import { fakeClock, memoryDb, rawRow } from '../db/test-utils.js';
import { makeJob } from '../events/test-utils.js';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import { FakeRunner, LIBRARY_REFS_FILE, LOG_FOOTAGE_MARKER } from '../pipeline/fake-runner.js';
import type { RunContext, RunLibraryRefs, Runner } from '../pipeline/runner.js';
import {
  type CameraTagProbe,
  createCameraPreparer,
  createTagProbe,
  curvesOfFootage,
  tagTexts,
} from './camera-luts.js';
import { createBuiltInLuts } from './lut-builtin.js';
import {
  countUses,
  EDIT_LUTS_DIR,
  type LutJobFilesOptions,
  type PendingLutUse,
  withLutRefs,
} from './lut-job-files.js';
import { cubeText, hasFfmpeg, invert, writeFakeSkill } from './lut-test-utils.js';

// LU10: what the footage says about camera log, and the one Camera LUT that matches. Real files in a
// temp inbox, a real repository on an in-memory database; ffprobe is a canned stand-in.

const dirs: string[] = [];
let root: string;
let inbox: string;
let jobDir: string;
let db: StudioDb;
let repo: LutRepository;
let events: LutChangedEvent[];
const warn = vi.fn();
const logger = { info: vi.fn(), warn, error: vi.fn() };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-camera-lut-'));
  dirs.push(root);
  inbox = join(root, 'inbox');
  jobDir = join(inbox, 'Ofek', 'FPV 3');
  mkdirSync(join(inbox, '_LUTs'), { recursive: true });
  mkdirSync(jobDir, { recursive: true });
  db = memoryDb();
  repo = new LutRepository(db, { clock: fakeClock() });
  events = [];
  warn.mockClear();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function addYours(name: string, kind: 'look' | 'camera' | 'fix' = 'camera') {
  const file = `${name}.cube`;
  const text = cubeText(5, invert);
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
    // No colour-grade skill here: only Yours.
    builtIn: createBuiltInLuts({ skillDir: join(root, 'no-skill'), dataDir: join(root, 'data') }),
    inboxPath: inbox,
    publish: (event) => events.push(event),
    logger,
    ...over,
  };
}

const clip = (name: string) => writeFileSync(join(jobDir, name), '');
const noTags: CameraTagProbe = async () => [];
/** The camera preparer's uses are noted here and counted by `commit()`, as withLutRefs does after a good run. */
let pending: PendingLutUse[] = [];
beforeEach(() => {
  pending = [];
});
const prepare = (probe: CameraTagProbe = noTags, byNote = false) =>
  createCameraPreparer(options(), probe)({ job: makeJob({ id: 'job1' }), jobDir, byNote, pending });
const commit = () => countUses(options(), 'job1', pending);
const lutFile = (slug: string) => join(jobDir, EDIT_LUTS_DIR, `${slug}.cube`);

describe('tagTexts', () => {
  it('collects every string tag of the container and its streams', () => {
    const json = JSON.stringify({
      format: { tags: { major_brand: 'XAVC', encoder: 'S-Log3 test' } },
      streams: [{ tags: { handler_name: 'VideoHandler' } }, { tags: {} }, {}],
    });
    expect(tagTexts(json)).toEqual(['XAVC', 'S-Log3 test', 'VideoHandler']);
  });

  it('leaves out long blobs, empty values and anything that is not text', () => {
    const json = JSON.stringify({
      format: { tags: { a: 'x'.repeat(500), b: '', c: 3, d: 'ok' } },
    });
    expect(tagTexts(json)).toEqual(['ok']);
  });

  it('answers nothing for text that is not ffprobe’s JSON', () => {
    expect(tagTexts('')).toEqual([]);
    expect(tagTexts('not json')).toEqual([]);
    expect(tagTexts('[]')).toEqual([]);
    expect(tagTexts('null')).toEqual([]);
  });
});

describe('createTagProbe', () => {
  it('answers nothing when ffprobe cannot run', async () => {
    expect(await createTagProbe('/no/such/ffprobe')('/no/such/file.mp4')).toEqual([]);
  });
});

describe('curvesOfFootage', () => {
  it('reads the curve from the file name, and from the tags when the name says nothing', async () => {
    clip('C0003 S-Log3.MP4');
    clip('B-roll.mp4');
    clip('IMG_9509.MOV');
    clip('notes.txt');
    const probe: CameraTagProbe = async (path) =>
      path.endsWith('B-roll.mp4') ? ['Canon C-Log3'] : [];

    expect(await curvesOfFootage(jobDir, probe)).toEqual([
      { relPath: 'B-roll.mp4', curve: 'clog3' },
      { relPath: 'C0003 S-Log3.MP4', curve: 'slog3' },
    ]);
  });

  it('does not ask ffprobe about a file whose name already says it', async () => {
    clip('A7S3_S-Log3_01.mp4');
    const probe = vi.fn(noTags);
    await curvesOfFootage(jobDir, probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('a file whose name and tags name two curves says nothing', async () => {
    clip('A7S3_S-Log3_01.mp4');
    expect(await curvesOfFootage(jobDir, async () => ['Panasonic V-Log'])).toEqual([
      { relPath: 'A7S3_S-Log3_01.mp4', curve: 'slog3' },
    ]);
    clip('mix.mp4');
    expect(await curvesOfFootage(jobDir, async () => ['S-Log3', 'V-Log'])).not.toContainEqual(
      expect.objectContaining({ relPath: 'mix.mp4' }),
    );
  });

  it('an iPhone clip (HLG, make and model only) names no curve', async () => {
    clip('IMG_9509.MOV');
    const tags = ['Apple', 'iPhone 14', '26.6.1', '2026-09-09T11:44:58+0300', 'HEVC'];
    expect(await curvesOfFootage(jobDir, async () => tags)).toEqual([]);
  });

  it('leaves out edit/, which is the editor’s own folder', async () => {
    mkdirSync(join(jobDir, 'edit'), { recursive: true });
    writeFileSync(join(jobDir, 'edit', 'S-Log3 test.mp4'), '');
    expect(await curvesOfFootage(jobDir, noTags)).toEqual([]);
  });
});

describe('the camera answer of an edit run', () => {
  it('no file names a curve: nothing to match, nothing copied', async () => {
    clip('IMG_9509.MOV');
    addYours('Sony S-Log3 to Rec709');
    expect(await prepare()).toEqual({ curves: [], byNote: false });
    expect(rawRow(db, 'lut_uses')).toEqual([]);
  });

  it('one Camera LUT names the curve: it is copied whole into the job, counted, and handed over', async () => {
    clip('FPV 3 S-Log3.mp4');
    const lut = addYours('Sony S-Log3 to Rec709');
    addYours('Canon C-Log3 to Rec709');
    addYours('S-Log3 Teal', 'look');

    const answer = await prepare();

    expect(answer).toEqual({
      byNote: false,
      curves: [
        {
          curve: 'slog3',
          label: 'Sony S-Log3',
          files: ['FPV 3 S-Log3.mp4'],
          match: {
            kind: 'one',
            lut: {
              slug: 'sony-s-log3-to-rec709',
              name: 'Sony S-Log3 to Rec709',
              kind: 'camera',
              owner: 'yours',
              path: 'edit/luts/sony-s-log3-to-rec709.cube',
              look: null,
            },
          },
        },
      ],
    });
    expect(readFileSync(lutFile('sony-s-log3-to-rec709'), 'utf8')).toBe(cubeText(5, invert));
    // Handed over, not yet used: the run has to succeed first (C54).
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    expect(events).toEqual([]);
    await commit();
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ lut_key: lut.id, job_id: 'job1', round: 0 }),
    ]);
    expect(events.filter((event) => event.type === 'lut.changed')).toHaveLength(1);
  });

  it('two Camera LUTs name the curve: it chooses neither and copies nothing', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Sony S-Log3 to Rec709');
    addYours('S-Log3 SGamut3.Cine to Rec709');

    const answer = await prepare();

    expect(answer.curves).toEqual([
      expect.objectContaining({
        curve: 'slog3',
        match: {
          kind: 'several',
          names: ['S-Log3 SGamut3.Cine to Rec709', 'Sony S-Log3 to Rec709'],
        },
      }),
    ]);
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    expect(() => readFileSync(lutFile('sony-s-log3-to-rec709'))).toThrow();
  });

  it('no Camera LUT names the curve: the answer says none', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Canon C-Log3 to Rec709');
    addYours('Warm look', 'look');

    expect((await prepare()).curves).toEqual([
      expect.objectContaining({ curve: 'slog3', match: { kind: 'none' } }),
    ]);
  });

  it('a library with no Camera LUT at all: none', async () => {
    clip('FPV 3 S-Log3.mp4');
    expect((await prepare()).curves[0]?.match).toEqual({ kind: 'none' });
  });

  it('answers each curve on its own, with the files that name it', async () => {
    clip('A_S-Log3_1.mp4');
    clip('B_S-Log3_2.mp4');
    clip('C_V-Log_1.mp4');
    addYours('Sony S-Log3 to Rec709');

    const answer = await prepare();

    expect(answer.curves.map((entry) => [entry.curve, entry.files, entry.match.kind])).toEqual([
      ['slog3', ['A_S-Log3_1.mp4', 'B_S-Log3_2.mp4'], 'one'],
      ['vlog', ['C_V-Log_1.mp4'], 'none'],
    ]);
  });

  it('names at most five files of a curve', async () => {
    for (let i = 1; i <= 8; i += 1) clip(`S-Log3 take ${i}.mp4`);
    expect((await prepare()).curves[0]?.files).toHaveLength(5);
  });

  it('a Camera LUT a note names wins: nothing is matched on its own', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Sony S-Log3 to Rec709');
    expect(await prepare(noTags, true)).toEqual({ curves: [], byNote: true });
    expect(rawRow(db, 'lut_uses')).toEqual([]);
  });

  it('a LUT whose file cannot be copied counts as no match, and says why in the log', async () => {
    clip('FPV 3 S-Log3.mp4');
    const lut = addYours('Sony S-Log3 to Rec709');
    rmSync(join(inbox, '_LUTs', lut.file));

    const answer = await prepare();

    expect(answer.curves[0]?.match).toEqual({ kind: 'none' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job1', lut: 'sony-s-log3-to-rec709' }),
      'could not copy the matching camera LUT into the job',
    );
  });

  it('a built-in Camera LUT (a gamut change) names no log curve', async () => {
    clip('FPV 3 S-Log3.mp4');
    const skill = writeFakeSkill(join(root, 'skill'));
    const answer = await createCameraPreparer(
      options({ builtIn: createBuiltInLuts({ skillDir: skill, dataDir: join(root, 'data') }) }),
      noTags,
    )({ job: makeJob({ id: 'job1' }), jobDir, byNote: false, pending });
    expect(answer.curves[0]?.match).toEqual({ kind: 'none' });
  });
});

describe('withLutRefs with the camera preparer', () => {
  const context = (): RunContext => ({ signal: new AbortController().signal, progress: () => {} });

  function recorder() {
    const seen: (RunContext | undefined)[] = [];
    const runner: Runner = {
      async start(_job, _mode, given) {
        seen.push(given);
        return { ok: true };
      },
    };
    return { seen, runner };
  }

  const wired = () => options({ camera: createCameraPreparer(options(), noTags) });
  const job = (over: Record<string, unknown> = {}) =>
    makeJob({ relPath: 'Ofek/FPV 3', id: 'job1', runKind: 'edit', note: null, ...over });

  it('an edit run gets the camera answer even when its note names nothing', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Sony S-Log3 to Rec709');
    const { seen, runner } = recorder();

    await withLutRefs(runner, wired(), logger).start(job(), 'start', context());

    const refs = seen[0]?.libraryRefs as RunLibraryRefs;
    expect(refs).toMatchObject({ luts: [], graphics: [], missing: [] });
    expect(refs.camera?.curves[0]?.match.kind).toBe('one');
  });

  it('the matched Camera LUT counts only when the run succeeded (C54)', async () => {
    clip('FPV 3 S-Log3.mp4');
    const lut = addYours('Sony S-Log3 to Rec709');
    const results = [{ ok: false as const, error: 'Usage limit reached' }, { ok: true as const }];
    const runner: Runner = { start: async () => results.shift() as never };
    const wrapped = withLutRefs(runner, wired(), logger);

    await wrapped.start(job(), 'start', context());
    expect(rawRow(db, 'lut_uses')).toEqual([]);
    expect(repo.usedCount(lut.id)).toBe(0);
    expect(events).toEqual([]);

    await wrapped.start(job(), 'retry', context());
    expect(rawRow(db, 'lut_uses')).toEqual([
      expect.objectContaining({ lut_key: lut.id, job_id: 'job1', round: 0 }),
    ]);
    expect(events.filter((event) => event.type === 'lut.changed')).toHaveLength(1);
  });

  it('a note that names a Camera LUT takes the camera answer to byNote and still copies it (LU9)', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Sony S-Log3 to Rec709');
    addYours('Canon C-Log3 to Rec709');
    const { seen, runner } = recorder();

    await withLutRefs(runner, wired(), logger).start(
      job({ note: 'use @luts/canon-c-log3-to-rec709' }),
      'start',
      context(),
    );

    const refs = seen[0]?.libraryRefs as RunLibraryRefs;
    expect(refs.luts.map((lut) => [lut.slug, lut.kind])).toEqual([
      ['canon-c-log3-to-rec709', 'camera'],
    ]);
    expect(refs.camera).toEqual({ curves: [], byNote: true });
    expect(() => readFileSync(lutFile('sony-s-log3-to-rec709'))).toThrow();
  });

  it('a note that names only a Look keeps the automatic match', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Sony S-Log3 to Rec709');
    addYours('Golden Hour', 'look');
    const { seen, runner } = recorder();

    await withLutRefs(runner, wired(), logger).start(
      job({ note: 'warm @luts/golden-hour' }),
      'start',
      context(),
    );

    const refs = seen[0]?.libraryRefs as RunLibraryRefs;
    expect(refs.luts.map((lut) => lut.slug)).toEqual(['golden-hour']);
    expect(refs.camera?.byNote).toBe(false);
    expect(refs.camera?.curves[0]?.match.kind).toBe('one');
  });

  it('a revise or render run gets no camera answer', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Sony S-Log3 to Rec709');
    const { seen, runner } = recorder();
    const given = context();

    await withLutRefs(runner, wired(), logger).start(
      job({ runKind: 'revise', round: 1 }),
      'start',
      given,
    );
    await withLutRefs(runner, wired(), logger).start(job({ runKind: 'render' }), 'start', given);

    expect(seen).toEqual([given, given]);
  });

  it('without the preparer the run is as LU9 left it', async () => {
    clip('FPV 3 S-Log3.mp4');
    const { seen, runner } = recorder();
    const given = context();
    await withLutRefs(runner, options(), logger).start(job(), 'start', given);
    expect(seen).toEqual([given]);
  });

  it('never fails a run: a preparer that throws is logged and the run starts without it', async () => {
    const { seen, runner } = recorder();
    const broken = options({
      camera: async () => {
        throw new Error('disk gone');
      },
    });
    const given = context();

    const outcome = await withLutRefs(runner, broken, logger).start(job(), 'start', given);

    expect(outcome).toEqual({ ok: true });
    expect(seen).toEqual([given]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job1' }),
      'could not look at the camera log of the footage',
    );
  });
});

// The whole path with the fake runner: a job with `.log-footage` in its folder stands for footage the
// grade measures as log. It needs ffmpeg (the fake runner makes its test videos with it).
describe.skipIf(!hasFfmpeg())('through the fake runner (a job that waits for a camera LUT)', () => {
  const FAST = 100_000;
  const context = (): RunContext => ({ signal: new AbortController().signal, progress: () => {} });
  const fake = () =>
    new FakeRunner({ inboxPath: inbox, speed: FAST, clipSeconds: 0.5, review: true });
  const wiredOptions = () => options({ camera: createCameraPreparer(options(), noTags) });
  const start = (over: Record<string, unknown> = {}, opts: LutJobFilesOptions = wiredOptions()) =>
    withLutRefs(fake(), opts, logger).start(
      makeJob({ relPath: 'Ofek/FPV 3', runKind: 'edit', step: 1, id: 'job7', note: null, ...over }),
      'start',
      context(),
    );
  const written = () =>
    JSON.parse(readFileSync(join(jobDir, 'edit', LIBRARY_REFS_FILE), 'utf8')) as RunLibraryRefs;

  beforeEach(() => {
    writeFileSync(join(jobDir, LOG_FOOTAGE_MARKER), '');
  });

  it('log footage that names a curve no Camera LUT has: the run fails at Cut with the sentence', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Canon C-Log3 to Rec709');

    const outcome = await start();

    expect(outcome).toEqual({
      ok: false,
      error: 'Waiting for a camera LUT: the clips are Sony S-Log3 (FPV 3 S-Log3.mp4).',
      step: 5,
    });
  });

  it('log footage with two matching Camera LUTs: it asks the person to name one', async () => {
    clip('FPV 3 S-Log3.mp4');
    addYours('Sony S-Log3 to Rec709');
    addYours('S-Log3 SGamut3.Cine to Rec709');

    const outcome = await start();

    expect(outcome.ok).toBe(false);
    expect(parseCameraLutWait(outcome.ok ? null : outcome.error)).toEqual({
      curve: 'slog3',
      source: 'FPV 3 S-Log3.mp4',
      several: true,
    });
  });

  it('log footage whose files name no curve: it waits for a camera LUT for log footage', async () => {
    clip('clip-01.mp4');
    addYours('Sony S-Log3 to Rec709');

    const outcome = await start();

    expect(outcome).toEqual({
      ok: false,
      error: 'Waiting for a camera LUT: the clips are log footage.',
      step: 5,
    });
  });

  it('after the Camera LUT is imported the same job goes on, with the LUT in the job', async () => {
    clip('FPV 3 S-Log3.mp4');
    expect((await start()).ok).toBe(false);

    addYours('Sony S-Log3 to Rec709');
    const outcome = await start();

    expect(outcome.ok).toBe(true);
    expect(written().camera?.curves[0]?.match).toMatchObject({
      kind: 'one',
      lut: { slug: 'sony-s-log3-to-rec709', path: 'edit/luts/sony-s-log3-to-rec709.cube' },
    });
    expect(readFileSync(lutFile('sony-s-log3-to-rec709'), 'utf8')).toBe(cubeText(5, invert));
  });

  it('a Camera LUT a note names lets log footage through', async () => {
    clip('clip-01.mp4');
    addYours('Sony S-Log3 to Rec709');

    const outcome = await start({ note: 'it is @luts/sony-s-log3-to-rec709' });

    expect(outcome.ok).toBe(true);
    expect(written().camera).toEqual({ curves: [], byNote: true });
  });

  it('footage the grade does not call log (no marker) is not held up', async () => {
    rmSync(join(jobDir, LOG_FOOTAGE_MARKER));
    clip('FPV 3 S-Log3.mp4');

    expect((await start()).ok).toBe(true);
  });

  it('with no camera answer (lutsInEdits off) nothing waits', async () => {
    clip('FPV 3 S-Log3.mp4');

    expect((await start({}, options())).ok).toBe(true);
  });

  it('a revise run is never held up', async () => {
    clip('FPV 3 S-Log3.mp4');
    await writeFakePreview(join(jobDir, 'edit'), 'FPV 3');
    writeFileSync(
      join(jobDir, 'edit', 'project.md'),
      '# Ofek: FPV 3\n\n## Session 1\n\nThe plan.\n',
    );
    mkdirSync(join(jobDir, 'edit', 'review'), { recursive: true });
    writeFileSync(
      join(jobDir, 'edit', 'review', 'round-1.md'),
      '# Review notes\n\n- 0:03.0: shorter\n',
    );

    const outcome = await start({ runKind: 'revise', round: 1, step: 4 });

    expect(outcome.ok).toBe(true);
  });
});
