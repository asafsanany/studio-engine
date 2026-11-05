import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFfprobe, DurationCache, type ProbeDuration, parseDuration } from './probe.js';

describe('parseDuration', () => {
  it('reads the decimal that ffprobe prints', () => {
    expect(parseDuration('12.345000\n')).toBeCloseTo(12.345);
    expect(parseDuration('0.000000')).toBe(0);
    expect(parseDuration('7')).toBe(7);
  });

  it('gives null for anything else', () => {
    for (const output of ['', 'N/A', 'N/A\n', 'abc', '-1.5', '1.5\n2.5', '1e3', 'Infinity']) {
      expect(parseDuration(output), JSON.stringify(output)).toBeNull();
    }
  });
});

describe('DurationCache', () => {
  function counting(durations: Record<string, number | null> = {}) {
    const calls: string[] = [];
    const probe: ProbeDuration = async (path) => {
      calls.push(path);
      return durations[path] ?? 10;
    };
    return { probe, calls };
  }

  it('probes a file once while path, mtime and size stay the same', async () => {
    const { probe, calls } = counting({ '/a.mp4': 12.5 });
    const cache = new DurationCache(probe);

    expect(await cache.seconds('/a.mp4', { mtimeMs: 1000, size: 50 })).toBe(12.5);
    expect(await cache.seconds('/a.mp4', { mtimeMs: 1000, size: 50 })).toBe(12.5);
    expect(calls).toEqual(['/a.mp4']);
    expect(cache.size).toBe(1);
  });

  it('probes again when the mtime or the size changes', async () => {
    const { probe, calls } = counting();
    const cache = new DurationCache(probe);

    await cache.seconds('/a.mp4', { mtimeMs: 1000, size: 50 });
    await cache.seconds('/a.mp4', { mtimeMs: 2000, size: 50 });
    await cache.seconds('/a.mp4', { mtimeMs: 2000, size: 51 });
    expect(calls).toHaveLength(3);
    // Only the newest version of the file is remembered.
    expect(cache.size).toBe(1);
  });

  it('keeps files with different paths apart', async () => {
    const { probe, calls } = counting({ '/a.mp4': 1, '/b.mp4': 2 });
    const cache = new DurationCache(probe);

    expect(await cache.seconds('/a.mp4', { mtimeMs: 1, size: 1 })).toBe(1);
    expect(await cache.seconds('/b.mp4', { mtimeMs: 1, size: 1 })).toBe(2);
    expect(calls).toEqual(['/a.mp4', '/b.mp4']);
  });

  it('counts an unreadable file as 0 seconds, never an error, and remembers that', async () => {
    let calls = 0;
    const answers: (number | null | 'throw')[] = [null, 'throw', Number.NaN, -3, 0];
    const probe: ProbeDuration = async () => {
      calls += 1;
      const answer = answers.shift();
      if (answer === 'throw') throw new Error('ffprobe exploded');
      return answer ?? null;
    };
    const cache = new DurationCache(probe);

    for (let i = 0; i < 5; i += 1) {
      expect(await cache.seconds(`/bad-${i}.mp4`, { mtimeMs: 1, size: 1 })).toBe(0);
    }
    expect(calls).toBe(5);

    await cache.seconds('/bad-0.mp4', { mtimeMs: 1, size: 1 });
    expect(calls).toBe(5);
    await cache.seconds('/bad-0.mp4', { mtimeMs: 2, size: 1 });
    expect(calls).toBe(6);
  });

  it('shares one probe between concurrent asks for the same file', async () => {
    let calls = 0;
    const probe: ProbeDuration = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 3;
    };
    const cache = new DurationCache(probe);

    const results = await Promise.all([
      cache.seconds('/a.mp4', { mtimeMs: 1, size: 1 }),
      cache.seconds('/a.mp4', { mtimeMs: 1, size: 1 }),
    ]);
    expect(results).toEqual([3, 3]);
    expect(calls).toBe(1);
  });

  it('runs no more probes at once than the limit allows, and finishes them all', async () => {
    let active = 0;
    let peak = 0;
    const probe: ProbeDuration = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return 1;
    };
    const cache = new DurationCache(probe, { concurrency: 3 });

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        cache.seconds(`/clip-${i}.mp4`, { mtimeMs: 1, size: 1 }),
      ),
    );
    expect(results).toEqual(Array(12).fill(1));
    expect(peak).toBe(3);
  });

  it('forgets everything on clear', async () => {
    const { probe, calls } = counting();
    const cache = new DurationCache(probe);

    await cache.seconds('/a.mp4', { mtimeMs: 1, size: 1 });
    cache.clear();
    expect(cache.size).toBe(0);
    await cache.seconds('/a.mp4', { mtimeMs: 1, size: 1 });
    expect(calls).toHaveLength(2);
  });
});

describe('createFfprobe', () => {
  it('gives null, not an error, when the executable does not exist', async () => {
    const probe = createFfprobe({ bin: join(tmpdir(), 'studio-no-such-ffprobe') });
    expect(await probe(join(tmpdir(), 'whatever.mp4'))).toBeNull();
  });
});

// The real thing, only when ffmpeg and ffprobe are installed (CI machines may not have them).
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0,
);

describe.skipIf(!hasFfmpeg)('real ffprobe', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-probe-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures a generated one second clip', async () => {
    const clip = join(dir, 'clip with spaces ✂.mp4');
    const made = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=64x64:rate=10:duration=1',
        '-pix_fmt',
        'yuv420p',
        clip,
      ],
      { encoding: 'utf8' },
    );
    expect(made.status, made.stderr).toBe(0);

    const seconds = await createFfprobe()(clip);
    expect(seconds).not.toBeNull();
    expect(seconds).toBeGreaterThan(0.9);
    expect(seconds).toBeLessThan(1.3);
  });

  it('gives null for a file that is not media, and for a missing file', async () => {
    const text = join(dir, 'notes.mp4');
    writeFileSync(text, 'this is not a video');

    const probe = createFfprobe();
    expect(await probe(text)).toBeNull();
    expect(await probe(join(dir, 'missing.mp4'))).toBeNull();
  });
});
