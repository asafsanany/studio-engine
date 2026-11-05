import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LUT_FRAMES } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { makeTempDir } from '../test-temp.js';
import { createFakeLutPreviews } from './fake-lut-previews.js';
import { lutFramePath } from './lut-frames.js';
import {
  createLutPreviews,
  createRealLutPreviews,
  fileSha256,
  lutPreviewKey,
  lutPreviewPath,
  lutPreviewVersion,
  type PreviewSource,
} from './lut-previews.js';
import { cubeText, hasCommand, identity, invert, jpegSize } from './lut-test-utils.js';

function tempDir(): string {
  return makeTempDir('studio-lut-previews-');
}

const SHA = 'abcdef0123456789'.repeat(4);

function source(dir: string, overrides: Partial<PreviewSource> = {}, cube = invert): PreviewSource {
  const cubePath = join(dir, 'Golden Hour Warm.cube');
  if (!existsSync(cubePath)) writeFileSync(cubePath, cubeText(9, cube));
  return { key: 'a1b2c3d4e5f6', kind: 'look', cubePath, look: null, sha256: SHA, ...overrides };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** A stand-in ffmpeg that counts its runs in `<dir>/runs` and then does `body`. */
function fakeFfmpeg(dir: string, body: string): string {
  const path = join(dir, 'ffmpeg-double');
  writeFileSync(path, `#!/bin/sh\necho run >> "${join(dir, 'runs')}"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const runsOf = (dir: string): number =>
  existsSync(join(dir, 'runs'))
    ? readFileSync(join(dir, 'runs'), 'utf8').trim().split('\n').length
    : 0;

describe('where the stills are cached', () => {
  it('keys a LUT by its id (or built-in slug) and the first 8 of its file hash', () => {
    expect(lutPreviewKey('a1b2c3d4e5f6', SHA)).toBe('a1b2c3d4e5f6-abcdef01');
    expect(lutPreviewKey('cinematic', null)).toBe('cinematic-look');
    expect(lutPreviewPath('/data', { key: 'film-contrast', sha256: SHA }, 'street', 'after')).toBe(
      '/data/lut-previews/film-contrast-abcdef01/street-after.jpg',
    );
  });

  it('makes the ?v= from the file hash and the kind, so marking a LUT Camera changes the address', () => {
    const look = lutPreviewVersion(SHA, 'look');
    expect(look).toMatch(/^[0-9a-f]{8}$/);
    expect(lutPreviewVersion(SHA, 'camera')).not.toBe(look);
    expect(lutPreviewVersion(SHA.replace('a', 'b'), 'look')).not.toBe(look);
    expect(lutPreviewVersion(null, 'look')).toBeNull();
    expect(lutPreviewVersion('not a hash', 'look')).toBeNull();
  });

  it('hashes a file once while its size and time stay the same', async () => {
    const dir = tempDir();
    const file = join(dir, 'a.cube');
    writeFileSync(file, 'one');
    const first = await fileSha256(file);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await fileSha256(file)).toBe(first);
    writeFileSync(file, 'other text');
    expect(await fileSha256(file)).not.toBe(first);
    await expect(fileSha256(join(dir, 'missing'))).rejects.toThrow();
  });
});

describe('the fake maker (runner: fake)', () => {
  it('copies the plain frame as the "after", the same every time and with no ffmpeg', async () => {
    const dir = tempDir();
    const previews = createFakeLutPreviews({ dataDir: dir });
    const src = source(dir);

    const after = await previews.still(src, 'person', 'after');

    expect(after).toBe(lutPreviewPath(dir, src, 'person', 'after'));
    expect(readFileSync(after).equals(readFileSync(lutFramePath('person')))).toBe(true);
    expect(await previews.still(src, 'person', 'after')).toBe(after);
    // The before is the bundled frame itself.
    expect(await previews.still(src, 'street', 'before')).toBe(lutFramePath('street'));
  });

  it('is picked by createLutPreviews for runner: fake, the real one for claude', async () => {
    const dir = tempDir();
    const src = source(dir);
    const fake = createLutPreviews({ ...loadConfig({ home: dir, env: {} }), runner: 'fake' });
    const path = await fake.still(src, 'interior', 'after');
    expect(readFileSync(path).equals(readFileSync(lutFramePath('interior')))).toBe(true);
  });

  it('warms the three "after" stills in the background and never throws', async () => {
    const dir = tempDir();
    const previews = createFakeLutPreviews({ dataDir: dir });
    const src = source(dir);

    previews.warm(src);
    previews.warm(src);
    await vi.waitFor(() => {
      for (const frame of LUT_FRAMES) {
        expect(existsSync(lutPreviewPath(dir, src, frame, 'after')), frame).toBe(true);
      }
    });
    expect(() => previews.warm({ ...src, cubePath: null })).not.toThrow();
  });
});

describe('a Camera LUT', () => {
  it('shows its flat -log twin as the before and the plain frame as the after, without ffmpeg', async () => {
    const dir = tempDir();
    const log = logger();
    // An ffmpeg that does not exist: any run would fail the test.
    const previews = createRealLutPreviews({
      dataDir: dir,
      ffmpegBin: join(dir, 'no-ffmpeg'),
      logger: log,
    });
    const src = source(dir, { kind: 'camera' });

    for (const frame of LUT_FRAMES) {
      expect(await previews.still(src, frame, 'before')).toBe(lutFramePath(frame, true));
      expect(await previews.still(src, frame, 'after')).toBe(lutFramePath(frame));
    }
    previews.warm(src);
    expect(log.warn).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'lut-previews'))).toBe(false);
  });

  it('is the same with the fake maker', async () => {
    const dir = tempDir();
    const previews = createFakeLutPreviews({ dataDir: dir });
    const src = source(dir, { kind: 'camera' });
    expect(await previews.still(src, 'person', 'before')).toBe(lutFramePath('person', true));
    expect(await previews.still(src, 'person', 'after')).toBe(lutFramePath('person'));
  });
});

describe('the stills of a LUT of Yours or a Fix (a stand-in ffmpeg)', () => {
  it('runs ffmpeg once for concurrent requests of the same still, and not again once it is cached', async () => {
    const dir = tempDir();
    const ffmpegBin = fakeFfmpeg(dir, 'sleep 0.2; for last; do :; done; echo jpeg > "$last"');
    const previews = createRealLutPreviews({ dataDir: dir, ffmpegBin });
    const src = source(dir);

    const paths = await Promise.all([
      previews.still(src, 'person', 'after'),
      previews.still(src, 'person', 'after'),
      previews.still(src, 'person', 'after'),
    ]);

    expect(new Set(paths).size).toBe(1);
    expect(runsOf(dir)).toBe(1);
    await previews.still(src, 'person', 'after');
    expect(runsOf(dir)).toBe(1);
    // Another frame is another run.
    await previews.still(src, 'street', 'after');
    expect(runsOf(dir)).toBe(2);
  });

  it('makes a new still when the file changed (the key has its hash), and leaves no work folder behind', async () => {
    const dir = tempDir();
    const ffmpegBin = fakeFfmpeg(dir, 'for last; do :; done; echo jpeg > "$last"');
    const previews = createRealLutPreviews({ dataDir: dir, ffmpegBin });
    const one = await previews.still(source(dir), 'person', 'after');
    const two = await previews.still(source(dir, { sha256: 'f'.repeat(64) }), 'person', 'after');
    expect(two).not.toBe(one);
    expect(runsOf(dir)).toBe(2);
    expect(readdirSync(join(dir, 'lut-previews', '.work'))).toEqual([]);
  });

  it('gives the LUT to ffmpeg under a generated name, whatever the file is called', async () => {
    const dir = tempDir();
    const argsFile = join(dir, 'args');
    const ffmpegBin = fakeFfmpeg(
      dir,
      `printf '%s\\n' "$@" > "${argsFile}"; ls >> "${argsFile}"; for last; do :; done; echo jpeg > "$last"`,
    );
    const previews = createRealLutPreviews({ dataDir: dir, ffmpegBin });
    const cubePath = join(dir, `It's "a:b,c=d" [1];x.cube`);
    writeFileSync(cubePath, cubeText(5, identity));

    await previews.still(source(dir, { cubePath }), 'person', 'after');

    const args = readFileSync(argsFile, 'utf8');
    expect(args).toContain('lut3d=file=lut.cube:interp=tetrahedral');
    expect(args).not.toContain('a:b');
    expect(args).toContain(lutFramePath('person'));
    expect(args).toMatch(/-q:v\n3\n/);
  });

  it('gives up after the timeout, logs it and makes no still; the next request tries again', async () => {
    const dir = tempDir();
    const log = logger();
    const ffmpegBin = fakeFfmpeg(dir, 'sleep 5');
    const previews = createRealLutPreviews({
      dataDir: dir,
      ffmpegBin,
      timeoutMs: 150,
      logger: log,
    });
    const src = source(dir);

    await expect(previews.still(src, 'person', 'after')).rejects.toThrow(/longer than/);

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(existsSync(lutPreviewPath(dir, src, 'person', 'after'))).toBe(false);
    await expect(previews.still(src, 'person', 'after')).rejects.toThrow();
    expect(runsOf(dir)).toBe(2);
  });

  it("rejects with ffmpeg's reason when it fails, and warm only logs", async () => {
    const dir = tempDir();
    const log = logger();
    const ffmpegBin = fakeFfmpeg(dir, 'echo "Invalid LUT" >&2; exit 1');
    const previews = createRealLutPreviews({ dataDir: dir, ffmpegBin, logger: log });
    const src = source(dir);

    await expect(previews.still(src, 'person', 'after')).rejects.toThrow(/Invalid LUT/);
    expect(() => previews.warm(src)).not.toThrow();
    await vi.waitFor(() => expect(runsOf(dir)).toBe(4));
    expect(log.warn).toHaveBeenCalledTimes(4);
  });

  it('cannot make a still of a LUT without a file or whose file is gone', async () => {
    const dir = tempDir();
    const previews = createRealLutPreviews({ dataDir: dir, ffmpegBin: fakeFfmpeg(dir, 'exit 0') });
    await expect(
      previews.still(source(dir, { cubePath: null }), 'person', 'after'),
    ).rejects.toThrow(/no file/);
    await expect(
      previews.still(source(dir, { cubePath: join(dir, 'gone.cube') }), 'person', 'after'),
    ).rejects.toThrow();
    expect(readdirSync(join(dir, 'lut-previews', '.work'))).toEqual([]);
  });

  it('starts the three stills of a LUT at once when it is warmed, two ffmpeg runs at a time', async () => {
    const dir = tempDir();
    const ffmpegBin = fakeFfmpeg(dir, 'for last; do :; done; echo jpeg > "$last"');
    const previews = createRealLutPreviews({ dataDir: dir, ffmpegBin });
    const src = source(dir);

    previews.warm(src);

    await vi.waitFor(() => {
      for (const frame of LUT_FRAMES) {
        expect(existsSync(lutPreviewPath(dir, src, frame, 'after')), frame).toBe(true);
      }
    });
    expect(runsOf(dir)).toBe(3);
  });
});

describe.skipIf(!hasCommand('ffmpeg'))('the stills with the real ffmpeg', () => {
  it('grades the test frame through the LUT: a 396×704 JPEG that differs from the frame', async () => {
    const dir = tempDir();
    const previews = createRealLutPreviews({ dataDir: dir });
    const inverted = source(dir, {}, invert);
    const same = source(dir, { key: 'ffffffffffff', cubePath: join(dir, 'same.cube') }, identity);
    writeFileSync(same.cubePath as string, cubeText(9, identity));

    const gradedPath = await previews.still(inverted, 'person', 'after');
    const identityPath = await previews.still(same, 'person', 'after');

    const graded = readFileSync(gradedPath);
    expect(graded.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(jpegSize(graded)).toEqual({ width: 396, height: 704 });
    expect(jpegSize(readFileSync(identityPath))).toEqual({ width: 396, height: 704 });
    expect(graded.equals(readFileSync(identityPath))).toBe(false);
    expect(graded.equals(readFileSync(lutFramePath('person')))).toBe(false);
  });

  it('works for a file whose name has quotes, colons, commas and brackets', async () => {
    const dir = tempDir();
    const previews = createRealLutPreviews({ dataDir: dir });
    const cubePath = join(dir, `It's "a:b,c=d" [1];x.cube`);
    writeFileSync(cubePath, cubeText(5, invert));

    const path = await previews.still(source(dir, { cubePath }), 'street', 'after');

    expect(jpegSize(readFileSync(path))).toEqual({ width: 396, height: 704 });
  });

  it('refuses a file ffmpeg cannot read, with a reason', async () => {
    const dir = tempDir();
    const log = logger();
    const previews = createRealLutPreviews({ dataDir: dir, logger: log });
    const cubePath = join(dir, 'broken.cube');
    writeFileSync(cubePath, 'LUT_3D_SIZE 3\n0 0 0\n');

    await expect(previews.still(source(dir, { cubePath }), 'person', 'after')).rejects.toThrow(
      /ffmpeg failed/,
    );
    expect(log.warn).toHaveBeenCalled();
  });
});
