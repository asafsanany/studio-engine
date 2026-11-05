import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Job, type JobPreview, jobFormatsOf } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newestSource } from '../clients/preview-video.js';
import { createVersionService, versionsToPrune } from './version-service.js';

const PREVIEW: JobPreview = { durationSec: 6, width: 1080, height: 1920 };

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A job with two formats (GN7): 9:16 is the main one, 1:1 the extra one in edit/preview-1x1/. */
const TWO_FORMATS = jobFormatsOf(['1080x1920', '1080x1080']);

function setup(options: { keep?: number; clock?: () => Date } = {}) {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-versions-'));
  temps.push(inbox);
  const jobDir = join(inbox, 'Acme', 'Teaser');
  const edit = join(jobDir, 'edit');
  const preview = join(edit, 'preview');
  mkdirSync(join(preview, 'compositions'), { recursive: true });
  mkdirSync(join(preview, '.hyperframes'), { recursive: true });
  mkdirSync(join(edit, 'music'), { recursive: true });
  writeFileSync(join(preview, 'index.html'), '<html>cut 1</html>');
  writeFileSync(join(preview, 'compositions', 'a.html'), 'a');
  writeFileSync(join(preview, 'cut.mp4'), 'video 1');
  writeFileSync(join(preview, '.DS_Store'), 'junk');
  writeFileSync(join(preview, '.hyperframes', 'cache.bin'), 'cache');
  writeFileSync(join(edit, 'music', 'music.json'), '{"picked":"v1"}');
  writeFileSync(join(edit, 'edl.json'), '{"cuts":1}');
  writeFileSync(join(edit, 'project.md'), 'project 1');

  let tick = 0;
  const warn = vi.fn();
  const service = createVersionService({
    inboxPath: inbox,
    logger: { info() {}, warn, error() {} },
    clock: () => new Date(Date.UTC(2026, 9, 25, 12, 0, tick++)),
    ...options,
  });
  const job = (round = 0) => ({ id: 'job-1', relPath: 'Acme/Teaser', round }) as Job;
  /** The same job with a second format; its composition is made by `addSquare`. */
  const twoFormatJob = (round = 0) =>
    ({ id: 'job-1', relPath: 'Acme/Teaser', round, formats: TWO_FORMATS }) as Job;
  const square = join(edit, 'preview-1x1');
  /** Writes (or rewrites) the 1:1 composition in edit/preview-1x1/, as the second format of a run. */
  const writeSquare = (cut: number) => {
    rmSync(join(square, 'compositions'), { recursive: true, force: true });
    mkdirSync(join(square, 'compositions'), { recursive: true });
    mkdirSync(join(square, '.hyperframes'), { recursive: true });
    writeFileSync(join(square, 'index.html'), `<html>square ${cut}</html>`);
    writeFileSync(join(square, 'compositions', `s${cut}.html`), `s${cut}`);
    writeFileSync(join(square, 'cut.mp4'), `square video ${cut}`);
    writeFileSync(join(square, '.DS_Store'), 'junk');
    writeFileSync(join(square, '.hyperframes', 'cache.bin'), 'cache');
  };
  const versionDir = (n: number) => join(edit, 'versions', `v${n}`);
  return { service, job, twoFormatJob, writeSquare, square, edit, preview, versionDir, warn };
}

describe('capture', () => {
  it('makes v1 with the preview, the music record, the EDL, the project notes and meta.json', async () => {
    const { service, job, edit, versionDir } = setup();

    const version = await service.capture(job(0), PREVIEW);

    expect(version).toEqual({
      n: 1,
      round: 0,
      createdAt: '2026-10-25T12:00:00.000Z',
      durationSec: 6,
      width: 1080,
      height: 1920,
      current: true,
    });
    const dir = versionDir(1);
    expect(readFileSync(join(dir, 'preview', 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
    expect(readFileSync(join(dir, 'preview', 'compositions', 'a.html'), 'utf8')).toBe('a');
    expect(readFileSync(join(dir, 'preview', 'cut.mp4'), 'utf8')).toBe('video 1');
    expect(readFileSync(join(dir, 'music.json'), 'utf8')).toBe('{"picked":"v1"}');
    expect(readFileSync(join(dir, 'edl.json'), 'utf8')).toBe('{"cuts":1}');
    expect(readFileSync(join(dir, 'project.md'), 'utf8')).toBe('project 1');
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toEqual({
      n: 1,
      round: 0,
      createdAt: '2026-10-25T12:00:00.000Z',
      preview: PREVIEW,
    });
    const index = JSON.parse(readFileSync(join(edit, 'versions', 'index.json'), 'utf8'));
    expect(index.current).toBe(1);
    expect(index.versions.map((v: { n: number }) => v.n)).toEqual([1]);
  });

  it('leaves out .hyperframes/ and .DS_Store, and leaves no temporary folder behind', async () => {
    const { service, job, edit, versionDir } = setup();

    await service.capture(job(0), PREVIEW);

    expect(existsSync(join(versionDir(1), 'preview', '.hyperframes'))).toBe(false);
    expect(existsSync(join(versionDir(1), 'preview', '.DS_Store'))).toBe(false);
    expect(readdirSync(join(edit, 'versions')).sort()).toEqual(['index.json', 'v1']);
  });

  it('keeps a snapshot that later edits of the live preview cannot reach', async () => {
    const { service, job, preview, versionDir } = setup();
    await service.capture(job(0), PREVIEW);

    // ffmpeg -y rewrites the live file in place; the version must be a clone, not the same inode.
    writeFileSync(join(preview, 'cut.mp4'), 'video 2');
    writeFileSync(join(preview, 'index.html'), '<html>cut 2</html>');

    expect(readFileSync(join(versionDir(1), 'preview', 'cut.mp4'), 'utf8')).toBe('video 1');
    expect(readFileSync(join(versionDir(1), 'preview', 'index.html'), 'utf8')).toBe(
      '<html>cut 1</html>',
    );
    expect(statSync(join(versionDir(1), 'preview', 'cut.mp4')).ino).not.toBe(
      statSync(join(preview, 'cut.mp4')).ino,
    );
  });

  it('numbers versions upward: round + 1 normally, never reusing a number on a re-edit', async () => {
    const { service, job } = setup();

    const first = await service.capture(job(0), PREVIEW);
    const second = await service.capture(job(1), PREVIEW);
    const reEdit = await service.capture(job(1), PREVIEW);

    expect([first.n, second.n, reEdit.n]).toEqual([1, 2, 3]);
    expect(reEdit.round).toBe(1);
  });

  it('starts a job from before versions at round + 1', async () => {
    const { service, job } = setup();

    expect((await service.capture(job(2), PREVIEW)).n).toBe(3);
  });

  it('skips the state files a job does not have', async () => {
    const { service, job, edit, versionDir } = setup();
    rmSync(join(edit, 'music'), { recursive: true });
    rmSync(join(edit, 'edl.json'));

    await service.capture(job(0), PREVIEW);

    expect(readdirSync(versionDir(1)).sort()).toEqual(['meta.json', 'preview', 'project.md']);
  });

  it('fails, leaving no half version and the list as it was, when the preview is missing', async () => {
    const { service, job, edit, preview } = setup();
    await service.capture(job(0), PREVIEW);
    rmSync(preview, { recursive: true });

    await expect(service.capture(job(1), PREVIEW)).rejects.toThrow();

    expect(readdirSync(join(edit, 'versions')).sort()).toEqual(['index.json', 'v1']);
    expect((await service.list(job(1))).map((v) => v.n)).toEqual([1]);
  });
});

describe('retention', () => {
  it('prunes the oldest on the 11th capture, and the index agrees with the folders', async () => {
    const { service, job, edit } = setup();

    for (let round = 0; round < 11; round++) await service.capture(job(round), PREVIEW);

    const versions = await service.list(job(10));
    expect(versions.map((v) => v.n)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(versions.filter((v) => v.current).map((v) => v.n)).toEqual([11]);
    expect(readdirSync(join(edit, 'versions')).sort()).toEqual(
      ['index.json', ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `v${n}`)].sort(),
    );
  });

  it('keeps as many as `keep` says', async () => {
    const { service, job } = setup({ keep: 2 });

    for (let round = 0; round < 4; round++) await service.capture(job(round), PREVIEW);

    expect((await service.list(job(3))).map((v) => v.n)).toEqual([4, 3]);
  });

  it('never prunes the current version, however old', () => {
    const versions = Array.from({ length: 12 }, (_, i) => ({ n: i + 1 }));

    expect(versionsToPrune(versions, null, 10)).toEqual([2, 1]);
    expect(versionsToPrune(versions, 1, 10)).toEqual([2]);
    expect(versionsToPrune(versions.slice(0, 10), 1, 10)).toEqual([]);
  });
});

describe('list', () => {
  it('is empty for a job from before versions', async () => {
    const { service, job, warn } = setup();

    expect(await service.list(job())).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is empty, with a log line, when the index cannot be read, and capture starts a new one', async () => {
    const { service, job, edit, warn } = setup();
    mkdirSync(join(edit, 'versions'), { recursive: true });
    writeFileSync(join(edit, 'versions', 'index.json'), 'not json');

    expect(await service.list(job())).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect((await service.capture(job(0), PREVIEW)).n).toBe(1);
  });
});

describe('restore', () => {
  /** Two versions: v1 is the first cut; the live preview, music pick, EDL and notes are then those of v2. */
  async function withTwoCuts(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(options);
    await ctx.service.capture(ctx.job(0), PREVIEW);
    writeFileSync(join(ctx.preview, 'index.html'), '<html>cut 2</html>');
    writeFileSync(join(ctx.preview, 'compositions', 'b.html'), 'b');
    writeFileSync(join(ctx.edit, 'music', 'music.json'), '{"picked":"v2"}');
    writeFileSync(join(ctx.edit, 'edl.json'), '{"cuts":2}');
    writeFileSync(join(ctx.edit, 'project.md'), 'project 2');
    await ctx.service.capture(ctx.job(1), { ...PREVIEW, durationSec: 9 });
    return ctx;
  }

  /** The leftovers of a swap in edit/. */
  const leftovers = (edit: string) =>
    readdirSync(edit).filter((name) => name.startsWith('.preview-'));

  it('swaps the preview, the music record, the EDL and the project notes for those of the version', async () => {
    const { service, job, edit, preview } = await withTwoCuts();

    const restored = await service.restore(job(1), 1);

    expect(restored).toMatchObject({ n: 1, durationSec: 6, current: true });
    expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
    expect(existsSync(join(preview, 'compositions', 'b.html'))).toBe(false);
    expect(readFileSync(join(preview, 'cut.mp4'), 'utf8')).toBe('video 1');
    expect(readFileSync(join(edit, 'music', 'music.json'), 'utf8')).toBe('{"picked":"v1"}');
    expect(readFileSync(join(edit, 'edl.json'), 'utf8')).toBe('{"cuts":1}');
    expect(readFileSync(join(edit, 'project.md'), 'utf8')).toMatch(
      /^project 1\n\n## Restored to Cut 1\n/,
    );
  });

  it('makes the version current, keeps every version, and leaves no temporary folder behind', async () => {
    const { service, job, edit } = await withTwoCuts();

    await service.restore(job(1), 1);

    const versions = await service.list(job(1));
    expect(versions.map((v) => [v.n, v.current])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(leftovers(edit)).toEqual([]);
    expect(readdirSync(join(edit, 'versions')).sort()).toEqual(['index.json', 'v1', 'v2']);
  });

  it('touches index.html, so the small MP4 made from the old preview is stale and made again', async () => {
    // The service's clock runs ahead of the files, so "now" is later than the small MP4 below.
    const { service, job, edit, preview } = await withTwoCuts({
      clock: () => new Date(Date.now() + 5000),
    });
    const lite = join(edit, 'preview-lite.mp4');
    writeFileSync(lite, 'lite');
    const made = new Date(Date.now() + 2000);
    utimesSync(lite, made, made);
    expect(statSync(lite).mtimeMs).toBeGreaterThanOrEqual(await newestSource(preview));

    await service.restore(job(1), 1);

    expect(statSync(lite).mtimeMs).toBeLessThan(await newestSource(preview));
  });

  it('can go forward again: a version restored from a restore', async () => {
    const { service, job, edit, preview } = await withTwoCuts();

    await service.restore(job(1), 1);
    await service.restore(job(1), 2);

    expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
    expect(readFileSync(join(edit, 'edl.json'), 'utf8')).toBe('{"cuts":2}');
    // The notes are the version's own, plus the line for this restore.
    expect(readFileSync(join(edit, 'project.md'), 'utf8')).toMatch(
      /^project 2\n\n## Restored to Cut 2\n/,
    );
    expect((await service.list(job(1))).find((v) => v.current)?.n).toBe(2);
  });

  it('keeps the version as it was: the live preview is a clone, not the same files', async () => {
    const { service, job, preview, versionDir } = await withTwoCuts();

    await service.restore(job(1), 1);
    writeFileSync(join(preview, 'cut.mp4'), 'rewritten by ffmpeg');

    expect(readFileSync(join(versionDir(1), 'preview', 'cut.mp4'), 'utf8')).toBe('video 1');
    expect(statSync(join(versionDir(1), 'preview', 'cut.mp4')).ino).not.toBe(
      statSync(join(preview, 'cut.mp4')).ino,
    );
  });

  it('changes nothing when the version is the current one', async () => {
    const { service, job, edit } = await withTwoCuts();

    expect(await service.restore(job(1), 2)).toMatchObject({ n: 2, current: true });

    expect(readFileSync(join(edit, 'project.md'), 'utf8')).toBe('project 2');
  });

  it('leaves a state file as it is when the version has none', async () => {
    const { service, job, edit, versionDir } = await withTwoCuts();
    rmSync(join(versionDir(1), 'edl.json'));

    await service.restore(job(1), 1);

    expect(readFileSync(join(edit, 'edl.json'), 'utf8')).toBe('{"cuts":2}');
  });

  it('refuses a version the job does not have, and one whose folder is gone, touching nothing', async () => {
    const { service, job, edit, preview, versionDir } = await withTwoCuts();

    await expect(service.restore(job(1), 7)).rejects.toMatchObject({ status: 404 });
    rmSync(versionDir(1), { recursive: true });
    await expect(service.restore(job(1), 1)).rejects.toMatchObject({ status: 404 });

    expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
    expect(readFileSync(join(edit, 'project.md'), 'utf8')).toBe('project 2');
    expect(leftovers(edit)).toEqual([]);
  });

  it('puts the replaced preview back when a restore died between the two renames', async () => {
    const { service, job, edit, preview } = await withTwoCuts();
    // What a crash after "rename preview to .preview-replaced" leaves.
    renameSync(preview, join(edit, '.preview-replaced'));
    mkdirSync(join(edit, '.preview-restore.tmp'));
    writeFileSync(join(edit, '.preview-restore.tmp', 'index.html'), 'half');

    // list heals it...
    expect((await service.list(job(1))).length).toBe(2);
    expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
    expect(leftovers(edit)).toEqual([]);

    // ...and so does the start of the next restore.
    renameSync(preview, join(edit, '.preview-replaced'));
    await service.restore(job(1), 1);
    expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
    expect(leftovers(edit)).toEqual([]);
  });

  it('removes a replaced preview that a restore died after the swap left behind', async () => {
    const { service, job, edit, preview } = await withTwoCuts();
    mkdirSync(join(edit, '.preview-replaced'));

    await service.list(job(1));

    expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
    expect(existsSync(join(edit, '.preview-replaced'))).toBe(false);
  });

  it('runs the restores of one job one after the other', async () => {
    const { service, job, preview } = await withTwoCuts();

    await Promise.all([service.restore(job(1), 1), service.restore(job(1), 2)]);

    expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
    expect((await service.list(job(1))).find((v) => v.current)?.n).toBe(2);
  });
});

describe('a job with more than one format (C63)', () => {
  /** Two cuts of a two-format job: v1 is the first cut of both compositions, the live ones are then those of v2. */
  async function withTwoCuts(options: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(options);
    ctx.writeSquare(1);
    await ctx.service.capture(ctx.twoFormatJob(0), PREVIEW);
    writeFileSync(join(ctx.preview, 'index.html'), '<html>cut 2</html>');
    writeFileSync(join(ctx.preview, 'compositions', 'b.html'), 'b');
    ctx.writeSquare(2);
    writeFileSync(join(ctx.edit, 'edl.json'), '{"cuts":2}');
    await ctx.service.capture(ctx.twoFormatJob(1), { ...PREVIEW, durationSec: 9 });
    return ctx;
  }

  /** The leftovers of a swap in edit/. */
  const leftovers = (edit: string) =>
    readdirSync(edit).filter((name) => /^\.preview(-|$)/.test(name));

  describe('capture', () => {
    it('keeps the composition of every format in the same version', async () => {
      const { service, twoFormatJob, writeSquare, versionDir } = setup();
      writeSquare(1);

      await service.capture(twoFormatJob(0), PREVIEW);

      const dir = versionDir(1);
      expect(readdirSync(dir).sort()).toEqual([
        'edl.json',
        'meta.json',
        'music.json',
        'preview',
        'preview-1x1',
        'project.md',
      ]);
      expect(readFileSync(join(dir, 'preview', 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
      expect(readFileSync(join(dir, 'preview-1x1', 'index.html'), 'utf8')).toBe(
        '<html>square 1</html>',
      );
      expect(readFileSync(join(dir, 'preview-1x1', 'compositions', 's1.html'), 'utf8')).toBe('s1');
      expect(readFileSync(join(dir, 'preview-1x1', 'cut.mp4'), 'utf8')).toBe('square video 1');
    });

    it('leaves out .hyperframes/ and .DS_Store of the extra format too, and keeps a snapshot of it', async () => {
      const { service, twoFormatJob, writeSquare, square, versionDir } = setup();
      writeSquare(1);
      await service.capture(twoFormatJob(0), PREVIEW);

      writeFileSync(join(square, 'cut.mp4'), 'rewritten by ffmpeg');

      const kept = join(versionDir(1), 'preview-1x1');
      expect(existsSync(join(kept, '.hyperframes'))).toBe(false);
      expect(existsSync(join(kept, '.DS_Store'))).toBe(false);
      expect(readFileSync(join(kept, 'cut.mp4'), 'utf8')).toBe('square video 1');
      expect(statSync(join(kept, 'cut.mp4')).ino).not.toBe(statSync(join(square, 'cut.mp4')).ino);
    });

    it('fails, leaving no half version and the list as it was, when the extra format is missing', async () => {
      const { service, twoFormatJob, writeSquare, square, edit } = setup();
      writeSquare(1);
      await service.capture(twoFormatJob(0), PREVIEW);
      rmSync(square, { recursive: true });

      await expect(service.capture(twoFormatJob(1), PREVIEW)).rejects.toThrow();

      expect(readdirSync(join(edit, 'versions')).sort()).toEqual(['index.json', 'v1']);
      expect((await service.list(twoFormatJob(1))).map((v) => v.n)).toEqual([1]);
    });

    it('keeps only preview/ for a one-format job, whatever else is in edit/', async () => {
      const { service, job, writeSquare, versionDir } = setup();
      // A folder of a format the job does not have (it has no `formats`): not part of its versions.
      writeSquare(1);

      await service.capture(job(0), PREVIEW);

      expect(readdirSync(versionDir(1)).sort()).toEqual([
        'edl.json',
        'meta.json',
        'music.json',
        'preview',
        'project.md',
      ]);
    });
  });

  describe('restore', () => {
    it('puts every format back together: both compositions come back, and what came later goes', async () => {
      const { service, twoFormatJob, edit, preview, square } = await withTwoCuts();

      const restored = await service.restore(twoFormatJob(1), 1);

      expect(restored).toMatchObject({ n: 1, durationSec: 6, current: true });
      expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
      expect(existsSync(join(preview, 'compositions', 'b.html'))).toBe(false);
      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 1</html>');
      expect(readFileSync(join(square, 'cut.mp4'), 'utf8')).toBe('square video 1');
      expect(existsSync(join(square, 'compositions', 's1.html'))).toBe(true);
      expect(existsSync(join(square, 'compositions', 's2.html'))).toBe(false);
      expect(readFileSync(join(edit, 'edl.json'), 'utf8')).toBe('{"cuts":1}');
      expect(leftovers(edit)).toEqual([]);
    });

    it('can go forward again: both formats come back from a restore', async () => {
      const { service, twoFormatJob, preview, square } = await withTwoCuts();

      await service.restore(twoFormatJob(1), 1);
      await service.restore(twoFormatJob(1), 2);

      expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 2</html>');
      expect(existsSync(join(square, 'compositions', 's1.html'))).toBe(false);
    });

    it('keeps the version as it was: the live extra composition is a clone', async () => {
      const { service, twoFormatJob, square, versionDir } = await withTwoCuts();

      await service.restore(twoFormatJob(1), 1);
      writeFileSync(join(square, 'cut.mp4'), 'rewritten by ffmpeg');

      const kept = join(versionDir(1), 'preview-1x1', 'cut.mp4');
      expect(readFileSync(kept, 'utf8')).toBe('square video 1');
      expect(statSync(kept).ino).not.toBe(statSync(join(square, 'cut.mp4')).ino);
    });

    it('touches the index.html of every format, so what is made from them is made again', async () => {
      const { service, twoFormatJob, preview, square } = await withTwoCuts({
        clock: () => new Date(Date.now() + 5000),
      });

      await service.restore(twoFormatJob(1), 1);

      const later = Date.now() + 3000;
      expect(statSync(join(preview, 'index.html')).mtimeMs).toBeGreaterThan(later);
      expect(statSync(join(square, 'index.html')).mtimeMs).toBeGreaterThan(later);
    });

    it('restores a version made before formats (only preview/): the main composition comes back, the extra one stays', async () => {
      const ctx = setup();
      // v1 was kept when the job had one format, so it holds preview/ and nothing else.
      await ctx.service.capture(ctx.job(0), PREVIEW);
      expect(existsSync(join(ctx.versionDir(1), 'preview-1x1'))).toBe(false);
      writeFileSync(join(ctx.preview, 'index.html'), '<html>cut 2</html>');
      ctx.writeSquare(2);
      await ctx.service.capture(ctx.twoFormatJob(1), PREVIEW);

      const restored = await ctx.service.restore(ctx.twoFormatJob(1), 1);

      expect(restored).toMatchObject({ n: 1, current: true });
      expect(readFileSync(join(ctx.preview, 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
      expect(readFileSync(join(ctx.square, 'index.html'), 'utf8')).toBe('<html>square 2</html>');
      expect(leftovers(ctx.edit)).toEqual([]);
      expect(ctx.warn).toHaveBeenCalledWith(
        expect.objectContaining({ dir: 'preview-1x1' }),
        expect.stringContaining('no such format'),
      );
    });

    it('leaves the folder of an extra format the job does not have alone, and does not warn for a one-format job', async () => {
      const { service, job, writeSquare, square, preview, warn } = setup();
      await service.capture(job(0), PREVIEW);
      writeFileSync(join(preview, 'index.html'), '<html>cut 2</html>');
      writeSquare(2);
      await service.capture(job(1), PREVIEW);

      await service.restore(job(1), 1);

      expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 2</html>');
      expect(warn).not.toHaveBeenCalled();
    });

    it('puts a missing live extra composition back from the version', async () => {
      const { service, twoFormatJob, square } = await withTwoCuts();
      rmSync(square, { recursive: true });

      await service.restore(twoFormatJob(1), 1);

      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 1</html>');
    });

    it('changes nothing when the version is the current one', async () => {
      const { service, twoFormatJob, square } = await withTwoCuts();

      await service.restore(twoFormatJob(1), 2);

      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 2</html>');
    });
  });

  describe('a restore that died half way', () => {
    it('puts every format back to the old cut when it died between the renames, never a mix', async () => {
      const { service, twoFormatJob, edit, preview, square } = await withTwoCuts();
      // What a crash after the main composition was swapped in and the extra one not yet leaves:
      // preview/ is the version's, .preview-replaced is the old one, preview-1x1 is set aside.
      renameSync(preview, join(edit, '.preview-replaced'));
      mkdirSync(preview);
      writeFileSync(join(preview, 'index.html'), '<html>cut 1</html>');
      renameSync(square, join(edit, '.preview-1x1-replaced'));
      mkdirSync(join(edit, '.preview-1x1-restore.tmp'));
      writeFileSync(join(edit, '.preview-1x1-restore.tmp', 'index.html'), 'half');

      // list heals it...
      expect((await service.list(twoFormatJob(1))).length).toBe(2);
      expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 2</html>');
      expect(leftovers(edit)).toEqual([]);

      // ...and so does the start of the next restore.
      renameSync(square, join(edit, '.preview-1x1-replaced'));
      await service.restore(twoFormatJob(1), 1);
      expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 1</html>');
      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 1</html>');
      expect(leftovers(edit)).toEqual([]);
    });

    it('removes the replaced folders of every format that a restore died after the swap left behind', async () => {
      const { service, twoFormatJob, edit, preview, square } = await withTwoCuts();
      mkdirSync(join(edit, '.preview-replaced'));
      mkdirSync(join(edit, '.preview-1x1-replaced'));

      await service.list(twoFormatJob(1));

      expect(readFileSync(join(preview, 'index.html'), 'utf8')).toBe('<html>cut 2</html>');
      expect(readFileSync(join(square, 'index.html'), 'utf8')).toBe('<html>square 2</html>');
      expect(leftovers(edit)).toEqual([]);
    });
  });
});
