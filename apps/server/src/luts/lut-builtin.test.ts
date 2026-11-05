import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_LUTS,
  LUT_FRAMES,
  LUT_MESSAGES,
  lutDetailSchema,
  lutSummarySchema,
} from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../test-temp.js';
import { createFakeLutPreviews } from './fake-lut-previews.js';
import {
  BAKED_LOOK_SIZE,
  builtInPreviewSource,
  colorGradeSkillDir,
  createBuiltInLuts,
  warmBuiltInLuts,
} from './lut-builtin.js';
import { lutStillNeedsGrade } from './lut-frames.js';
import { lutPreviewPath } from './lut-previews.js';
import { cubeText, hasCommand, invert, writeFakeSkill } from './lut-test-utils.js';

function tempDir(): string {
  return makeTempDir('studio-lut-builtin-');
}

function setup(skip: readonly string[] = []) {
  const root = tempDir();
  const skillDir = writeFakeSkill(join(root, 'skill'), skip);
  const dataDir = join(root, 'data');
  return { root, skillDir, dataDir };
}

const hasPython = hasCommand('python3', '--version');
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('where the skill is', () => {
  it('is STUDIO_COLOR_GRADE_DIR, else ~/.claude/skills/color-grade-ai (as grade_batch.py reads it)', () => {
    expect(colorGradeSkillDir({ STUDIO_COLOR_GRADE_DIR: '/x/skill' })).toBe('/x/skill');
    expect(colorGradeSkillDir({})).toMatch(/\.claude[\\/]skills[\\/]color-grade-ai$/);
    expect(colorGradeSkillDir({ STUDIO_COLOR_GRADE_DIR: '' })).toMatch(/color-grade-ai$/);
  });
});

describe('the built-in catalog without the skill', () => {
  it('is not available and has no rows when the folder is missing', async () => {
    const { root } = setup();
    const builtIn = createBuiltInLuts({ skillDir: join(root, 'nothing-here') });

    expect(await builtIn.available()).toBe(false);
    expect(await builtIn.list(new Map())).toEqual([]);
    expect(await builtIn.get('film-contrast', 0, null)).toBeNull();
    expect(await builtIn.cubePath('film-contrast')).toBeNull();
    expect(await builtIn.cubeFile('film-contrast')).toBeNull();
    expect(LUT_MESSAGES.builtInMissing).toContain('pnpm color-grade:install');
  });

  it('is not available when any one file is missing', async () => {
    const { skillDir } = setup(['sat_reduce.cube']);
    const builtIn = createBuiltInLuts({ skillDir });

    expect(await builtIn.available()).toBe(false);
    expect(await builtIn.list(new Map())).toEqual([]);
  });
});

describe('the built-in catalog with the skill', () => {
  it('lists the 19 rows by name, each with its kind and grid, owned by Built in', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir });

    const rows = await builtIn.list(new Map());

    expect(await builtIn.available()).toBe(true);
    expect(rows.map((row) => row.slug)).toEqual(BUILTIN_LUTS.map((row) => row.slug));
    expect(rows).toHaveLength(19);
    for (const row of rows) {
      expect(lutSummarySchema.safeParse(row).success, row.slug).toBe(true);
      expect(row).toMatchObject({ owner: 'builtIn', addedAt: null, isNew: false });
    }
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    expect(bySlug.get('red-skin-fix')).toMatchObject({ kind: 'fix', size: 17 });
    expect(bySlug.get('s-gamut3-to-cine')).toMatchObject({ kind: 'camera', size: 17 });
    expect(bySlug.get('golden-warm')).toMatchObject({ kind: 'look', size: 17 });
  });

  it('counts the jobs that used a row, and says "Used by the cinematic look" for the chain’s parts at 0', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir });

    const rows = new Map(
      (
        await builtIn.list(
          new Map([
            ['golden-warm', 3],
            ['film-contrast', 1],
            ['cool-shift', 1],
          ]),
        )
      ).map((row) => [row.slug, row]),
    );

    expect(rows.get('golden-warm')).toMatchObject({ used: 3, usedLabel: '3 jobs' });
    expect(rows.get('cool-shift')).toMatchObject({ used: 1, usedLabel: '1 job' });
    expect(rows.get('film-contrast')).toMatchObject({ used: 1, usedLabel: '1 job' });
    expect(rows.get('black-lift')).toMatchObject({ used: 0, usedLabel: 'Not used yet' });
    expect(rows.get('cinematic')).toMatchObject({
      used: 0,
      usedLabel: 'Used by the cinematic look',
    });
    const unused = await builtIn.list(new Map());
    expect(unused.find((row) => row.slug === 'film-contrast')?.usedLabel).toBe(
      'Used by the cinematic look',
    );
  });

  it('resolves a slug to its file in correction_luts, and Cinematic to none', async () => {
    const { skillDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir });

    for (const row of BUILTIN_LUTS) {
      const path = await builtIn.cubePath(row.slug);
      if (row.look !== null) expect(path, row.slug).toBeNull();
      else expect(path, row.slug).toBe(join(skillDir, 'correction_luts', row.files[0] as string));
    }
    expect(await builtIn.cubePath('studio-balanced')).toMatch(/studio_balanced_baked\.cube$/);
    expect(await builtIn.cubePath('golden-hour-warm')).toBeNull();
    expect(await builtIn.cubeFile('golden-hour-warm')).toBeNull();
    expect(await builtIn.cubeFile('golden-warm')).toBe(await builtIn.cubePath('golden-warm'));
  });

  it('describes one row for the pane: description, note, file, size and bytes', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir });

    const detail = await builtIn.get('red-skin-fix', 0, 2);

    expect(lutDetailSchema.parse(detail)).toMatchObject({
      slug: 'red-skin-fix',
      kind: 'fix',
      description: 'Turns red or flushed skin to peach.',
      file: 'red_skin_fix.cube',
      sizeLabel: '17 × 17 × 17',
      usedIn: 2,
    });
    expect(detail?.note).toContain('clean test frame');
    expect(detail?.bytes).toBe(
      statSync(join(skillDir, 'correction_luts', 'red_skin_fix.cube')).size,
    );
    expect(await builtIn.get('no-such-lut', 0, null)).toBeNull();
  });

  it('gives each row a previewKey from its file, which changes when the file does', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir, python: 'python3' });
    const rows = await builtIn.list(new Map());
    // Every row has one; only Cinematic needs the bake (which needs python3).
    const without = rows.filter((row) => !row.previewKey).map((row) => row.slug);
    expect(without).toEqual(hasPython ? [] : ['cinematic']);
    const before = (await builtIn.list(new Map())).find((row) => row.slug === 'cool-shift');

    const file = join(skillDir, 'correction_luts', 'cool_shift.cube');
    writeFileSync(file, cubeText(17, invert));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const after = (await builtIn.list(new Map())).find((row) => row.slug === 'cool-shift');

    expect(before?.previewKey).toMatch(/^[0-9a-f]{8}$/);
    expect(after?.previewKey).toMatch(/^[0-9a-f]{8}$/);
    expect(after?.previewKey).not.toBe(before?.previewKey);
  });
});

describe.skipIf(!hasPython)('the Cinematic look (a chain, baked by grade_batch.py)', () => {
  it('is one 33-point .cube made by --bake-look, cached under the data folder', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir, python: 'python3' });

    const file = await builtIn.cubeFile('cinematic');

    expect(file).not.toBeNull();
    expect(file).toContain(join(dataDir, 'lut-previews', '_baked'));
    const text = readFileSync(file as string, 'utf8');
    expect(text).toContain('film_contrast_80 x 0.8, golden_warm x 0.4');
    // The size the list assumes without baking is the size the script writes.
    expect(text).toContain(`LUT_3D_SIZE ${BAKED_LOOK_SIZE}`);
    expect(
      text
        .trim()
        .split('\n')
        .filter((line) => /^[\d.]+ [\d.]+ [\d.]+$/.test(line)),
    ).toHaveLength(BAKED_LOOK_SIZE ** 3);
    // It is the row's file for a copy, but Cinematic still has no file of its own in the skill.
    expect(await builtIn.cubePath('cinematic')).toBeNull();
  });

  it('is baked once: later asks, and concurrent ones, share the file', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir, python: 'python3' });

    const [a, b] = await Promise.all([
      builtIn.cubeFile('cinematic'),
      builtIn.cubeFile('cinematic'),
    ]);
    const modified = statSync(a as string).mtimeMs;
    const c = await builtIn.cubeFile('cinematic');
    const again = await createBuiltInLuts({ skillDir, dataDir, python: 'python3' }).cubeFile(
      'cinematic',
    );

    expect(new Set([a, b, c, again]).size).toBe(1);
    expect(statSync(a as string).mtimeMs).toBe(modified);
  });

  it('is baked again when a file of the skill changes', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir, python: 'python3' });
    const first = await builtIn.cubeFile('cinematic');

    const file = join(skillDir, 'correction_luts', 'golden_warm.cube');
    writeFileSync(
      file,
      cubeText(17, (r, g, b) => [r * 0.5, g, b]),
    );
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const second = await builtIn.cubeFile('cinematic');

    expect(second).not.toBe(first);
    expect(existsSync(second as string)).toBe(true);
  });

  it('gets a previewKey, a size and no file or bytes in its pane', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir, python: 'python3' });

    const detail = await builtIn.get('cinematic', 0, null);

    expect(lutDetailSchema.parse(detail)).toMatchObject({
      slug: 'cinematic',
      kind: 'look',
      size: BAKED_LOOK_SIZE,
      file: null,
      bytes: null,
      usedLabel: 'Used by the cinematic look',
    });
    expect(detail?.previewKey).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is the real skill’s chain when this Mac has it (the file the render would apply)', async () => {
    const real = colorGradeSkillDir();
    if (!existsSync(join(real, 'correction_luts', 'film_contrast_80.cube'))) return;
    const { dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir: real, dataDir, python: 'python3' });

    const file = await builtIn.cubeFile('cinematic');

    expect(file).not.toBeNull();
    expect(readFileSync(file as string, 'utf8')).toContain(`LUT_3D_SIZE ${BAKED_LOOK_SIZE}`);
  });
});

describe('when the Cinematic bake fails', () => {
  it('answers none, logs it, and tries again only after a wait', async () => {
    const { skillDir, dataDir } = setup();
    const log = logger();
    let now = 1_000;
    const builtIn = createBuiltInLuts({
      skillDir,
      dataDir,
      python: join(dataDir, 'no-python'),
      logger: log,
      now: () => now,
      bakeRetryMs: 30_000,
    });

    expect(await builtIn.cubeFile('cinematic')).toBeNull();
    expect(await builtIn.cubeFile('cinematic')).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    now += 31_000;
    expect(await builtIn.cubeFile('cinematic')).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(2);

    // The rest of Built in still works, with no key for Cinematic.
    const rows = await builtIn.list(new Map());
    expect(rows).toHaveLength(19);
    expect(rows.find((row) => row.slug === 'cinematic')?.previewKey).toBeNull();
    expect(rows.find((row) => row.slug === 'cool-shift')?.previewKey).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('the sources of the built-in stills', () => {
  it('gives a row its file and hash, or none when the file is not there', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir, dataDir, python: join(dataDir, 'no-python') });
    const row = (slug: string) =>
      BUILTIN_LUTS.find((r) => r.slug === slug) as (typeof BUILTIN_LUTS)[number];

    const source = await builtInPreviewSource(builtIn, row('led-green-fix'));
    expect(source).toMatchObject({ key: 'led-green-fix', kind: 'fix', look: null });
    expect(source?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source?.cubePath).toMatch(/led_green_fix\.cube$/);
    expect(await builtInPreviewSource(builtIn, row('cinematic'))).toBeNull();
  });

  it('are all warmed after boot with the previews queue', async () => {
    const { skillDir, dataDir } = setup();
    const builtIn = createBuiltInLuts({
      skillDir,
      dataDir,
      python: hasPython ? 'python3' : 'none',
    });
    const previews = createFakeLutPreviews({ dataDir });
    const warm = vi.spyOn(previews, 'warm');

    await warmBuiltInLuts(builtIn, previews);

    expect(warm).toHaveBeenCalledTimes(hasPython ? 19 : 18);
    // Every warmed still, not just one: the rest would be written into the folder after the test.
    for (const [source] of warm.mock.calls) {
      if (!lutStillNeedsGrade('after', source.kind)) continue; // a camera LUT's stills are the frames
      for (const frame of LUT_FRAMES) {
        await vi.waitFor(() => {
          expect(existsSync(lutPreviewPath(dataDir, source, frame, 'after'))).toBe(true);
        });
      }
    }
    expect(warm.mock.calls.some(([source]) => source.key === 'cool-shift')).toBe(true);
  });

  it('warm nothing, and do not throw, without the skill', async () => {
    const { root, dataDir } = setup();
    const builtIn = createBuiltInLuts({ skillDir: join(root, 'none'), dataDir });
    const previews = createFakeLutPreviews({ dataDir });
    const warm = vi.spyOn(previews, 'warm');

    await expect(warmBuiltInLuts(builtIn, previews)).resolves.toBeUndefined();
    expect(warm).not.toHaveBeenCalled();
  });
});
