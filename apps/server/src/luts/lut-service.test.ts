import { createHash } from 'node:crypto';
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
import { LUT_MESSAGES, type LutKind } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LutRepository } from '../db/lut-repository.js';
import { memoryDb } from '../db/test-utils.js';
import { type LutProver, prepareLutText } from './lut-check.js';
import type { PreviewSource } from './lut-previews.js';
import {
  type BuiltInLuts,
  CINEMATIC_HAS_NO_FILE,
  createLutService,
  type LutEvent,
  type LutOutcome,
  type LutService,
} from './lut-service.js';
import { createLutStaging } from './lut-staging.js';
import { make3dl, makeCube, TINT } from './lut-test-utils.js';

const opened: ReturnType<typeof memoryDb>[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {} };

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `studio-lut-${label}-`));
  dirs.push(dir);
  return dir;
}

function ok<Body>(outcome: LutOutcome<Body>): Body {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.body;
}

/** A tiny catalog: Film contrast (a file in the "skill"), Cinematic (no file), Warm shift. */
function fakeBuiltIn(skillDir: string, available = true): BuiltInLuts {
  const files: Record<string, string> = {
    'film-contrast': join(skillDir, 'film_contrast.cube'),
    'warm-shift': join(skillDir, 'warm_shift.cube'),
  };
  return {
    available: async () => available,
    list: async () => [],
    get: async () => null,
    cubePath: async (slug) => {
      const path = files[slug];
      return path !== undefined && existsSync(path) ? path : null;
    },
    cubeFile: async (slug) => {
      const path = files[slug];
      return path !== undefined && existsSync(path) ? path : null;
    },
  };
}

function setup(options: { prover?: LutProver; builtInAvailable?: boolean; usedIn?: boolean } = {}) {
  const db = memoryDb();
  opened.push(db);
  const dataDir = tempDir('data');
  const inbox = tempDir('inbox');
  const home = tempDir('home');
  const skill = tempDir('skill');
  writeFileSync(join(skill, 'film_contrast.cube'), makeCube(5, TINT));
  writeFileSync(join(skill, 'warm_shift.cube'), makeCube(9, TINT));
  const repo = new LutRepository(db);
  const events: LutEvent[] = [];
  const warmed: PreviewSource[] = [];
  const opened_: string[] = [];
  const proved: string[] = [];
  const service = createLutService({
    repo,
    builtIn: fakeBuiltIn(skill, options.builtInAvailable ?? true),
    staging: createLutStaging({ dataDir }),
    previews: { still: async () => '', warm: (source) => warmed.push(source) },
    inboxPath: inbox,
    publish: (event) => events.push(event),
    usedIn: options.usedIn ?? false,
    openFolder: async (path) => {
      opened_.push(path);
    },
    prover:
      options.prover ??
      (async (path) => {
        proved.push(path);
        return null;
      }),
    dataDir,
    home,
    logger,
  });
  return { service, repo, events, warmed, opened: opened_, proved, dataDir, inbox, home, skill };
}

type Setup = ReturnType<typeof setup>;

/** Stages the files the way the route does: an upload into the stage's folder, then the check. */
async function stageFiles(
  { service }: Setup,
  files: readonly { name: string; content: string | Buffer }[],
) {
  const stage = await service.beginStage();
  const received = files.map((file, index) => {
    const path = join(stage.dir, `f${index}.upload`);
    const content = typeof file.content === 'string' ? Buffer.from(file.content) : file.content;
    writeFileSync(path, content);
    return { name: file.name, path, bytes: content.length };
  });
  return { stage, outcome: await service.stage(stage, received) };
}

async function importAll(
  s: Setup,
  files: { name: string; content: string }[],
  kind: LutKind = 'look',
) {
  const { stage, outcome } = await stageFiles(s, files);
  const staged = ok(outcome);
  const items = staged.files.filter((file) => file.ok).map((file) => ({ id: file.id, kind }));
  return ok(await s.service.importStaged({ stageId: stage.stageId, items }));
}

describe('stage', () => {
  it('answers one verdict per file: good, bad, and not a LUT at all', async () => {
    const s = setup();
    const { stage, outcome } = await stageFiles(s, [
      { name: 'Golden Hour.cube', content: makeCube(5, TINT) },
      { name: 'S-Log3 to Rec709.3dl', content: make3dl(5, TINT) },
      { name: 'broken.cube', content: 'LUT_3D_SIZE 3\n0 0 0\n' },
      { name: 'one-d.cube', content: 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n' },
      { name: 'poster.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]) },
    ]);
    const body = ok(outcome);
    expect(body.stageId).toBe(stage.stageId);
    expect(body.files).toEqual([
      {
        id: 'f0',
        name: 'Golden Hour.cube',
        ok: true,
        error: null,
        size: 5,
        bytes: expect.any(Number),
        kindGuess: 'look',
      },
      {
        id: 'f1',
        name: 'S-Log3 to Rec709.3dl',
        ok: true,
        error: null,
        size: 5,
        bytes: expect.any(Number),
        kindGuess: 'camera',
      },
      {
        id: 'f2',
        name: 'broken.cube',
        ok: false,
        error: LUT_MESSAGES.badRows,
        size: null,
        bytes: 20,
        kindGuess: 'look',
      },
      {
        id: 'f3',
        name: 'one-d.cube',
        ok: false,
        error: LUT_MESSAGES.oneD,
        size: null,
        bytes: expect.any(Number),
        kindGuess: 'look',
      },
      {
        id: 'f4',
        name: 'poster.png',
        ok: false,
        error: LUT_MESSAGES.badExtension,
        size: null,
        bytes: 5,
        kindGuess: 'look',
      },
    ]);
  });

  it('refuses a file over the 40 MB limit as a verdict (the upload keeps no bytes for it)', async () => {
    const s = setup();
    const stage = await s.service.beginStage();
    const outcome = await s.service.stage(stage, [
      { name: 'huge.cube', path: join(stage.dir, 'f0.upload'), bytes: 41 * 1024 * 1024 },
    ]);
    expect(ok(outcome).files[0]).toMatchObject({ ok: false, error: LUT_MESSAGES.tooLarge });
  });

  it('refuses an empty upload', async () => {
    const s = setup();
    const stage = await s.service.beginStage();
    expect(await s.service.stage(stage, [])).toEqual({
      ok: false,
      status: 400,
      error: LUT_MESSAGES.badImport,
    });
  });

  it('keeps nothing in _LUTs and no row before the import', async () => {
    const s = setup();
    await stageFiles(s, [{ name: 'a.cube', content: makeCube(3) }]);
    expect(s.repo.list()).toEqual([]);
    expect(existsSync(join(s.inbox, '_LUTs'))).toBe(false);
    expect(s.events).toEqual([]);
  });
});

describe('importStaged', () => {
  it('imports 2 good files and reports the bad one: rows, files, events, previews', async () => {
    const s = setup();
    const { stage, outcome } = await stageFiles(s, [
      { name: 'Golden Hour Warm.cube', content: makeCube(5, TINT) },
      { name: 'Teal Orange.3dl', content: make3dl(5, TINT) },
      { name: 'broken.cube', content: 'nope' },
    ]);
    const staged = ok(outcome);
    expect(staged.files.map((file) => file.ok)).toEqual([true, true, false]);

    const result = ok(
      await s.service.importStaged({
        stageId: stage.stageId,
        items: [
          { id: 'f0', kind: 'look' },
          { id: 'f1', kind: 'fix' },
          { id: 'f2', kind: 'look' },
          { id: 'f9', kind: 'look' },
        ],
      }),
    );

    expect(
      result.imported.map((lut) => [lut.slug, lut.kind, lut.size, lut.owner, lut.isNew]),
    ).toEqual([
      ['golden-hour-warm', 'look', 5, 'yours', true],
      ['teal-orange', 'fix', 5, 'yours', true],
    ]);
    expect(result.failed).toEqual([
      { id: 'f2', error: LUT_MESSAGES.badImportItem },
      { id: 'f9', error: LUT_MESSAGES.badImportItem },
    ]);
    expect(readdirSync(join(s.inbox, '_LUTs')).sort()).toEqual([
      'Golden Hour Warm.cube',
      'Teal Orange.cube',
    ]);
    // a .3dl is stored as the converted .cube
    const stored = readFileSync(join(s.inbox, '_LUTs', 'Teal Orange.cube'), 'utf8');
    expect(stored).toContain('LUT_3D_SIZE 5');
    // the rows say what was imported: size, bytes, hash, source name
    const row = s.repo.getBySlug('teal-orange');
    expect(row).toMatchObject({
      name: 'Teal Orange',
      file: 'Teal Orange.cube',
      sourceName: 'Teal Orange.3dl',
      bytes: Buffer.byteLength(stored),
      sha256: createHash('sha256').update(stored).digest('hex'),
    });
    // one lut.changed per row, and the previews were started from the stored file
    expect(s.events.map((event) => event.type)).toEqual(['lut.changed', 'lut.changed']);
    expect(
      s.warmed.map((source) => [
        source.key,
        source.kind,
        source.sha256 === row?.sha256 || source.sha256 !== null,
      ]),
    ).toEqual([
      [expect.any(String), 'look', true],
      [row?.id, 'fix', true],
    ]);
    expect(s.warmed[1]?.cubePath).toBe(join(s.inbox, '_LUTs', 'Teal Orange.cube'));
    // the stage is gone
    expect(readdirSync(join(s.dataDir, 'lut-staging'))).toEqual([]);
  });

  it('gives a name that clashes " (2)", " (3)" … and counts Built in names as taken', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    const second = await importAll(s, [{ name: 'golden.cube', content: makeCube(3) }]);
    const third = await importAll(s, [{ name: 'GOLDEN.cube', content: makeCube(3) }]);
    expect(second.imported[0]?.slug).toBe('golden-2');
    expect(third.imported[0]?.slug).toBe('golden-3');
    const builtIn = await importAll(s, [{ name: 'Film contrast.cube', content: makeCube(3) }]);
    expect(builtIn.imported[0]).toMatchObject({
      name: 'Film contrast (2)',
      slug: 'film-contrast-2',
    });
    expect(readdirSync(join(s.inbox, '_LUTs')).sort()).toEqual([
      'Film contrast (2).cube',
      'GOLDEN (3).cube',
      'Golden.cube',
      'golden (2).cube',
    ]);
  });

  it('numbers two files of the same name in one import', async () => {
    const s = setup();
    const result = await importAll(s, [
      { name: 'Same.cube', content: makeCube(3) },
      { name: 'Same.cube', content: makeCube(4) },
    ]);
    expect(result.imported.map((lut) => lut.slug)).toEqual(['same', 'same-2']);
  });

  it('skips a name whose file is already in _LUTs without a row, and one that makes another slug’s', async () => {
    const s = setup();
    mkdirSync(join(s.inbox, '_LUTs'));
    writeFileSync(join(s.inbox, '_LUTs', 'Stray.cube'), 'someone put this here');
    await importAll(s, [{ name: 'Warm Film.cube', content: makeCube(3) }]);
    const result = await importAll(s, [
      { name: 'Stray.cube', content: makeCube(3) },
      { name: 'warm-film.cube', content: makeCube(3) },
    ]);
    expect(result.imported.map((lut) => lut.name)).toEqual(['Stray (2)', 'warm-film (2)']);
    expect(readFileSync(join(s.inbox, '_LUTs', 'Stray.cube'), 'utf8')).toBe(
      'someone put this here',
    );
  });

  it('names a file by its base name: no folders, no extension, no slashes or colons', async () => {
    const s = setup();
    const result = await importAll(s, [
      { name: 'A:B.cube', content: makeCube(3) },
      { name: '.hidden.cube', content: makeCube(3) },
      { name: 'שקיעה.cube', content: makeCube(3) },
    ]);
    expect(result.imported.map((lut) => lut.name)).toEqual(['A–B', 'hidden', 'שקיעה']);
    expect(result.imported[2]?.slug).toMatch(/^lut-[0-9a-f]{6}$/);
  });

  it('keeps going when one file fails the final proof: { imported, failed }', async () => {
    const prover: LutProver = async (path) =>
      readFileSync(path, 'utf8').includes('0.050000') ? null : LUT_MESSAGES.ffmpegRefused;
    const s = setup({ prover });
    const { stage, outcome } = await stageFiles(s, [
      { name: 'good.cube', content: makeCube(3, TINT) },
      { name: 'odd.cube', content: makeCube(3, () => [0.2, 0.2, 0.2]) },
      { name: 'good two.cube', content: makeCube(4, TINT) },
    ]);
    const files = ok(outcome).files;
    const result = ok(
      await s.service.importStaged({
        stageId: stage.stageId,
        items: files.map((file) => ({ id: file.id, kind: 'look' as const })),
      }),
    );
    expect(result.imported.map((lut) => lut.slug)).toEqual(['good', 'good-two']);
    expect(result.failed).toEqual([{ id: 'f1', error: LUT_MESSAGES.ffmpegRefused }]);
    expect(readdirSync(join(s.inbox, '_LUTs')).sort()).toEqual(['good two.cube', 'good.cube']);
  });

  it('proves the staged .cube (a controlled name), not the original', async () => {
    const s = setup();
    await importAll(s, [{ name: "it's, odd: [x];.cube", content: makeCube(3) }]);
    expect(s.proved).toHaveLength(1);
    expect(s.proved[0]).toMatch(/lut-staging\/[0-9a-f]{12}\/f0\.cube$/);
  });

  it('answers 404 for a stage that is gone, and 200 with nothing imported when all fail', async () => {
    const s = setup();
    expect(
      await s.service.importStaged({
        stageId: '000000000000',
        items: [{ id: 'f0', kind: 'look' }],
      }),
    ).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.stageNotFound,
    });
    const { stage } = await stageFiles(s, [{ name: 'a.cube', content: makeCube(3) }]);
    const none = await s.service.importStaged({
      stageId: stage.stageId,
      items: [{ id: 'f7', kind: 'look' }],
    });
    expect(none).toMatchObject({
      ok: true,
      status: 200,
      body: { imported: [], failed: [{ id: 'f7' }] },
    });
    // and the stage is spent
    expect(
      await s.service.importStaged({ stageId: stage.stageId, items: [{ id: 'f0', kind: 'look' }] }),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('imports a file only once when the same id is listed twice', async () => {
    const s = setup();
    const { stage } = await stageFiles(s, [{ name: 'a.cube', content: makeCube(3) }]);
    const result = ok(
      await s.service.importStaged({
        stageId: stage.stageId,
        items: [
          { id: 'f0', kind: 'look' },
          { id: 'f0', kind: 'fix' },
        ],
      }),
    );
    expect(result.imported).toHaveLength(1);
    expect(result.failed).toEqual([{ id: 'f0', error: LUT_MESSAGES.badImportItem }]);
  });

  it('forgets a stage that was reaped', async () => {
    const s = setup();
    const { stage } = await stageFiles(s, [{ name: 'a.cube', content: makeCube(3) }]);
    rmSync(stage.dir, { recursive: true });
    expect(
      await s.service.importStaged({ stageId: stage.stageId, items: [{ id: 'f0', kind: 'look' }] }),
    ).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe('cancelStage', () => {
  it('removes the stage once; an unknown one is 404', async () => {
    const s = setup();
    const { stage } = await stageFiles(s, [{ name: 'a.cube', content: makeCube(3) }]);
    expect(ok(await s.service.cancelStage(stage.stageId))).toEqual({ ok: true });
    expect(existsSync(stage.dir)).toBe(false);
    expect(await s.service.cancelStage(stage.stageId)).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.stageNotFound,
    });
  });
});

describe('get and list', () => {
  it('answers the detail of Yours with usedIn only while lutsInEdits is on', async () => {
    for (const usedIn of [false, true]) {
      const s = setup({ usedIn });
      const { imported } = await importAll(s, [{ name: 'Golden.cube', content: makeCube(5) }]);
      const row = s.repo.getBySlug(imported[0]?.slug ?? '');
      if (row === null) throw new Error('no row');
      s.repo.addUse(row.id, 'job-1', 0);
      s.repo.addUse(row.id, 'job-2', 0);
      const detail = ok(await s.service.get('golden'));
      expect(detail).toMatchObject({
        slug: 'golden',
        file: 'Golden.cube',
        used: 2,
        usedLabel: '2 jobs',
        sizeLabel: '5 × 5 × 5',
      });
      expect(detail.usedIn).toBe(usedIn ? 2 : null);
    }
  });

  it('is 404 for an unknown slug, and 409 for a built-in one while the skill is missing', async () => {
    const s = setup({ builtInAvailable: false });
    expect(await s.service.get('nope')).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.notFound,
    });
    expect(await s.service.get('film-contrast')).toEqual({
      ok: false,
      status: 409,
      error: LUT_MESSAGES.builtInMissing,
    });
  });
});

describe('update (rename and kind)', () => {
  it('renames the row, the file on disk and the slug, and tells the bus removed-then-changed', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(5, TINT) }]);
    const before = readFileSync(join(s.inbox, '_LUTs', 'Golden.cube'), 'utf8');
    s.events.length = 0;

    const detail = ok(await s.service.update('golden', { name: '  Sunset: Amber  ' }));

    expect(detail).toMatchObject({
      name: 'Sunset– Amber',
      slug: 'sunset-amber',
      file: 'Sunset– Amber.cube',
    });
    expect(readdirSync(join(s.inbox, '_LUTs'))).toEqual(['Sunset– Amber.cube']);
    expect(readFileSync(join(s.inbox, '_LUTs', 'Sunset– Amber.cube'), 'utf8')).toBe(before);
    expect(s.repo.getBySlug('golden')).toBeNull();
    expect(s.events).toEqual([
      { type: 'lut.removed', slug: 'golden' },
      {
        type: 'lut.changed',
        lut: expect.objectContaining({ slug: 'sunset-amber', name: 'Sunset– Amber' }),
      },
    ]);
  });

  it('renames to the same name in another case: the slug stays, the file follows, only changed is sent', async () => {
    const s = setup();
    await importAll(s, [{ name: 'golden.cube', content: makeCube(3) }]);
    s.events.length = 0;
    const detail = ok(await s.service.update('golden', { name: 'Golden' }));
    expect(detail).toMatchObject({ name: 'Golden', slug: 'golden', file: 'Golden.cube' });
    expect(readdirSync(join(s.inbox, '_LUTs'))).toEqual(['Golden.cube']);
    expect(s.events.map((event) => event.type)).toEqual(['lut.changed']);
  });

  it('refuses a name another LUT has (Built in too), an empty one, and a file by that name that no row owns', async () => {
    const s = setup();
    await importAll(s, [
      { name: 'One.cube', content: makeCube(3) },
      { name: 'Two.cube', content: makeCube(3) },
    ]);
    writeFileSync(join(s.inbox, '_LUTs', 'Stray.cube'), 'x');
    s.events.length = 0;
    const refused = (status: number, error: string) => ({ ok: false, status, error });
    expect(await s.service.update('one', { name: 'two' })).toEqual(
      refused(422, LUT_MESSAGES.nameTaken),
    );
    expect(await s.service.update('one', { name: 'Film contrast' })).toEqual(
      refused(422, LUT_MESSAGES.nameTaken),
    );
    expect(await s.service.update('one', { name: 'Stray' })).toEqual(
      refused(422, LUT_MESSAGES.nameTaken),
    );
    expect(await s.service.update('one', { name: '   ' })).toEqual(
      refused(422, LUT_MESSAGES.nameEmpty),
    );
    expect(readdirSync(join(s.inbox, '_LUTs')).sort()).toEqual([
      'One.cube',
      'Stray.cube',
      'Two.cube',
    ]);
  });

  it('marks a kind without moving anything, and only says changed', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    s.events.length = 0;
    const detail = ok(await s.service.update('golden', { kind: 'camera' }));
    expect(detail.kind).toBe('camera');
    expect(s.events.map((event) => event.type)).toEqual(['lut.changed']);
    // the same kind again says nothing
    s.events.length = 0;
    ok(await s.service.update('golden', { kind: 'camera' }));
    expect(s.events).toEqual([]);
  });

  it('does both at once', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    const detail = ok(await s.service.update('golden', { name: 'Dusk', kind: 'fix' }));
    expect(detail).toMatchObject({ slug: 'dusk', kind: 'fix' });
  });

  it('renames a row whose file is gone, and 404s an unknown slug', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    rmSync(join(s.inbox, '_LUTs', 'Golden.cube'));
    expect(ok(await s.service.update('golden', { name: 'Dusk' })).file).toBe('Dusk.cube');
    expect(await s.service.update('nope', { name: 'x' })).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.notFound,
    });
  });

  it('refuses a built-in LUT: 409 with the message, nothing changed', async () => {
    const s = setup();
    expect(await s.service.update('film-contrast', { name: 'x' })).toEqual({
      ok: false,
      status: 409,
      error: LUT_MESSAGES.builtInReadOnly,
    });
    expect(await s.service.remove('film-contrast')).toEqual({
      ok: false,
      status: 409,
      error: LUT_MESSAGES.builtInReadOnly,
    });
    expect(s.events).toEqual([]);
  });
});

describe('remove', () => {
  it('moves the file to the Trash, soft-deletes the row and says lut.removed', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    s.events.length = 0;
    const done = ok(await s.service.remove('golden'));
    expect(done).toEqual({ ok: true, where: join(s.home, '.Trash', 'Golden.cube') });
    expect(readdirSync(join(s.home, '.Trash'))).toEqual(['Golden.cube']);
    expect(readdirSync(join(s.inbox, '_LUTs'))).toEqual([]);
    expect(s.repo.getBySlug('golden')).toBeNull();
    expect(s.events).toEqual([{ type: 'lut.removed', slug: 'golden' }]);
    expect(await s.service.get('golden')).toMatchObject({ ok: false, status: 404 });
  });

  it('numbers a file the Trash already has, as Finder does', async () => {
    const s = setup();
    mkdirSync(join(s.home, '.Trash'));
    writeFileSync(join(s.home, '.Trash', 'Golden.cube'), 'old');
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    const done = ok(await s.service.remove('golden'));
    expect(done.where).toBe(join(s.home, '.Trash', 'Golden 2.cube'));
    expect(readFileSync(join(s.home, '.Trash', 'Golden.cube'), 'utf8')).toBe('old');
  });

  it('keeps the file in <data>/deleted-luts when the Trash will not take it', async () => {
    const s = setup();
    writeFileSync(join(s.home, '.Trash'), 'a file where the folder should be');
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    const done = ok(await s.service.remove('golden'));
    expect(done.where).toBe(join(s.dataDir, 'deleted-luts', 'Golden.cube'));
    expect(existsSync(done.where)).toBe(true);
    expect(s.repo.getBySlug('golden')).toBeNull();
  });

  it('fails with 500 and keeps the row when neither place works', async () => {
    const s = setup();
    writeFileSync(join(s.home, '.Trash'), 'x');
    writeFileSync(join(s.dataDir, 'deleted-luts'), 'x');
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    expect(await s.service.remove('golden')).toEqual({
      ok: false,
      status: 500,
      error: LUT_MESSAGES.deleteFailed,
    });
    expect(s.repo.getBySlug('golden')).not.toBeNull();
    expect(existsSync(join(s.inbox, '_LUTs', 'Golden.cube'))).toBe(true);
  });

  it('deletes a row whose file is already gone', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    rmSync(join(s.inbox, '_LUTs', 'Golden.cube'));
    ok(await s.service.remove('golden'));
    expect(s.repo.getBySlug('golden')).toBeNull();
  });

  it('frees the name for a new import', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    ok(await s.service.remove('golden'));
    const again = await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    expect(again.imported[0]?.slug).toBe('golden');
  });
});

describe('duplicate', () => {
  it('copies Yours as "X (2)" with the same kind, size and bytes, and starts its previews', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(5, TINT) }], 'fix');
    s.events.length = 0;
    s.warmed.length = 0;
    const copy = ok(await s.service.duplicate('golden'));
    expect(copy).toMatchObject({
      name: 'Golden (2)',
      slug: 'golden-2',
      kind: 'fix',
      size: 5,
      file: 'Golden (2).cube',
      used: 0,
    });
    expect(readFileSync(join(s.inbox, '_LUTs', 'Golden (2).cube'), 'utf8')).toBe(
      readFileSync(join(s.inbox, '_LUTs', 'Golden.cube'), 'utf8'),
    );
    expect(s.repo.getBySlug('golden-2')?.sha256).toBe(s.repo.getBySlug('golden')?.sha256);
    expect(s.events.map((event) => event.type)).toEqual(['lut.changed']);
    expect(s.warmed).toHaveLength(1);
    // and again
    expect(ok(await s.service.duplicate('golden')).slug).toBe('golden-3');
    expect(ok(await s.service.duplicate('golden-2')).slug).toBe('golden-2-2');
  });

  it('is 404 when the file is gone', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    rmSync(join(s.inbox, '_LUTs', 'Golden.cube'));
    expect(await s.service.duplicate('golden')).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.fileMissing,
    });
  });

  it('copies a built-in LUT into Yours with its kind kept and its size read from the file', async () => {
    const s = setup();
    const copy = ok(await s.service.duplicate('warm-shift'));
    expect(copy).toMatchObject({
      name: 'Warm shift (2)',
      slug: 'warm-shift-2',
      kind: 'look',
      size: 9,
      owner: 'yours',
    });
    expect(readFileSync(join(s.inbox, '_LUTs', 'Warm shift (2).cube'), 'utf8')).toBe(
      readFileSync(join(s.skill, 'warm_shift.cube'), 'utf8'),
    );
    expect(s.repo.getBySlug('warm-shift-2')).toMatchObject({ sourceName: 'warm_shift.cube' });
    // the skill's own file is untouched
    expect(readdirSync(s.skill).sort()).toEqual(['film_contrast.cube', 'warm_shift.cube']);
  });

  it('keeps a built-in Camera LUT a Camera LUT', async () => {
    const s = setup();
    writeFileSync(join(s.skill, 'sgamut3_to_cine.cube'), makeCube(3));
    const service: LutService = createLutService({
      repo: s.repo,
      builtIn: {
        ...fakeBuiltIn(s.skill),
        cubeFile: async (slug) =>
          slug === 's-gamut3-to-cine' ? join(s.skill, 'sgamut3_to_cine.cube') : null,
      },
      staging: createLutStaging({ dataDir: s.dataDir }),
      previews: { still: async () => '', warm() {} },
      inboxPath: s.inbox,
      publish() {},
      usedIn: false,
      logger,
    });
    expect(ok(await service.duplicate('s-gamut3-to-cine'))).toMatchObject({
      kind: 'camera',
      slug: 's-gamut3-to-cine-2',
    });
  });

  it('copies the Cinematic look from its baked cube, as a Look in Yours', async () => {
    const s = setup();
    writeFileSync(join(s.skill, 'cinematic-baked.cube'), makeCube(5, TINT));
    const service: LutService = createLutService({
      repo: s.repo,
      builtIn: {
        ...fakeBuiltIn(s.skill),
        cubeFile: async (slug) =>
          slug === 'cinematic' ? join(s.skill, 'cinematic-baked.cube') : null,
      },
      staging: createLutStaging({ dataDir: s.dataDir }),
      previews: { still: async () => '', warm() {} },
      inboxPath: s.inbox,
      publish() {},
      usedIn: false,
      logger,
    });
    expect(ok(await service.duplicate('cinematic'))).toMatchObject({
      slug: 'cinematic-2',
      kind: 'look',
      size: 5,
      owner: 'yours',
    });
    expect(readFileSync(join(s.inbox, '_LUTs', 'Cinematic (2).cube'), 'utf8')).toBe(
      readFileSync(join(s.skill, 'cinematic-baked.cube'), 'utf8'),
    );
  });

  it('cannot copy the Cinematic look when its cube could not be made: 409 with the reason', async () => {
    const s = setup();
    expect(await s.service.duplicate('cinematic')).toEqual({
      ok: false,
      status: 409,
      error: CINEMATIC_HAS_NO_FILE,
    });
    expect(s.repo.list()).toEqual([]);
  });

  it('is 409 when the colour grade is not installed, 404 for an unknown slug', async () => {
    const s = setup({ builtInAvailable: false });
    expect(await s.service.duplicate('film-contrast')).toEqual({
      ok: false,
      status: 409,
      error: LUT_MESSAGES.builtInMissing,
    });
    expect(await s.service.duplicate('nope')).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.notFound,
    });
  });
});

describe('reveal', () => {
  it('shows Yours’ file, and a built-in LUT’s file in the skill', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    expect(ok(await s.service.reveal('golden'))).toEqual({ ok: true });
    expect(ok(await s.service.reveal('film-contrast'))).toEqual({ ok: true });
    expect(s.opened).toEqual([
      join(s.inbox, '_LUTs', 'Golden.cube'),
      join(s.skill, 'film_contrast.cube'),
    ]);
  });

  it('is 404 for a missing file, the Cinematic look and an unknown slug; 409 without the skill', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    rmSync(join(s.inbox, '_LUTs', 'Golden.cube'));
    expect(await s.service.reveal('golden')).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.fileMissing,
    });
    expect(await s.service.reveal('cinematic')).toEqual({
      ok: false,
      status: 404,
      error: CINEMATIC_HAS_NO_FILE,
    });
    expect(await s.service.reveal('nope')).toEqual({
      ok: false,
      status: 404,
      error: LUT_MESSAGES.notFound,
    });
    expect(await setup({ builtInAvailable: false }).service.reveal('film-contrast')).toEqual({
      ok: false,
      status: 409,
      error: LUT_MESSAGES.builtInMissing,
    });
    expect(s.opened).toEqual([]);
  });

  it('answers 500 when Finder cannot be asked', async () => {
    const s = setup();
    await importAll(s, [{ name: 'Golden.cube', content: makeCube(3) }]);
    const failing = createLutService({
      repo: s.repo,
      builtIn: fakeBuiltIn(s.skill),
      staging: createLutStaging({ dataDir: s.dataDir }),
      previews: { still: async () => '', warm() {} },
      inboxPath: s.inbox,
      publish() {},
      usedIn: false,
      openFolder: vi.fn().mockRejectedValue(new Error('no Finder')),
      logger,
    });
    expect(await failing.reveal('golden')).toEqual({
      ok: false,
      status: 500,
      error: LUT_MESSAGES.revealFailed,
    });
  });
});

describe('what the check lets through is what the import keeps', () => {
  it('stores the .cube text the check approved', async () => {
    const s = setup();
    const text = makeCube(4, TINT, { eol: '\r\n' });
    await importAll(s, [{ name: 'Crlf.cube', content: text }]);
    const prepared = prepareLutText('Crlf.cube', text, text.length);
    expect(prepared.ok && readFileSync(join(s.inbox, '_LUTs', 'Crlf.cube'), 'utf8')).toBe(text);
  });
});
