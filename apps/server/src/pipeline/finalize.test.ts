import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Job, jobOutputSchema } from '@studio/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { resolveFfmpeg } from './fake-media.js';
import {
  type CopyFile,
  copyFileStreamed,
  createFinalize,
  ExportError,
  exportFileNamePart,
  exportRelPath,
  numberedName,
} from './finalize.js';

// The export step on real files in temp folders. The videos are tiny ffmpeg test patterns; the
// tests that need ffmpeg/ffprobe are skipped, with a note, when either is missing.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
if (!haveTools) {
  console.warn(
    'finalize.test.ts: ffmpeg/ffprobe not found on PATH or in /opt/homebrew/bin; skipping the tests that need them (brew install ffmpeg)',
  );
}

const live = new AbortController().signal;

let db: StudioDb;
let jobs: JobRepository;
const temps: string[] = [];

beforeAll(() => {
  db = memoryDb();
  jobs = new JobRepository(db);
});

afterAll(() => {
  if (db.sqlite.open) db.close();
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jobFor(client: string, name: string): Job {
  return jobs.upsertFromScan(makeScan(client, name)).job;
}

interface Workspace {
  inbox: string;
  exportsDir: string;
  job: Job;
  jobDir: string;
  /** `<exportsDir>/<Client>` as the default naming puts it. */
  clientDir: string;
  /** The job's `edit/final.mp4`. */
  finalPath: string;
  /** Puts `file` in place as the job's finished video. */
  putFinal(file: string): void;
  finalize: ReturnType<typeof createFinalize>;
}

function workspace(
  client = 'Acme',
  name = 'Spring promo',
  { exportsOutside = false }: { exportsOutside?: boolean } = {},
): Workspace {
  const base = mkdtempSync(join(tmpdir(), 'studio-finalize-'));
  temps.push(base);
  const inbox = join(base, 'inbox');
  const exportsDir = exportsOutside ? join(base, 'shared exports') : join(inbox, '_Exports');
  const job = jobFor(client, name);
  const jobDir = join(inbox, job.relPath);
  mkdirSync(join(jobDir, 'edit'), { recursive: true });
  const finalPath = join(jobDir, 'edit', 'final.mp4');
  return {
    inbox,
    exportsDir,
    job,
    jobDir,
    clientDir: join(exportsDir, client.normalize('NFC')),
    finalPath,
    putFinal: (file) => copyFileSync(file, finalPath),
    finalize: createFinalize({ inboxPath: inbox, exportsDir }),
  };
}

/** Hidden entries only: what a half-written export may look like to the inbox watcher and Finder. */
const visible = (dir: string): string[] =>
  readdirSync(dir)
    .filter((entry) => !entry.startsWith('.'))
    .sort();

describe('export names', () => {
  it('is Client/Job.mp4 with a forward slash', () => {
    expect(exportRelPath({ client: 'Acme', name: 'Spring promo' })).toBe('Acme/Spring promo.mp4');
  });

  it('keeps Hebrew and emoji exactly', () => {
    expect(exportRelPath({ client: 'לקוח א', name: 'סרטון אביב 🌸' })).toBe(
      'לקוח א/סרטון אביב 🌸.mp4',
    );
  });

  it('replaces only the characters macOS cannot have in a name, with a hyphen', () => {
    expect(exportFileNamePart('Promo: spring/summer')).toBe('Promo- spring-summer');
    expect(exportFileNamePart("Dave's (final) v2 & more!")).toBe("Dave's (final) v2 & more!");
  });

  it('writes the name in Unicode NFC', () => {
    const decomposed = 'Café';
    expect(exportFileNamePart(decomposed)).toBe('Café');
    expect(exportRelPath({ client: decomposed, name: 'Menu' })).toBe('Café/Menu.mp4');
  });

  it('numbers an older export before the extension', () => {
    expect(numberedName('/x/Acme/Promo.mp4', 1)).toBe('/x/Acme/Promo (1).mp4');
    expect(numberedName('Acme/Promo.mp4', 12)).toBe('Acme/Promo (12).mp4');
  });
});

describe('errors that need no video tools', () => {
  it('says so when the edit left no final.mp4', async () => {
    const ws = workspace();
    await expect(ws.finalize(ws.job, live)).rejects.toThrow(
      'The edit finished but there is no edit/final.mp4 to export',
    );
    expect(existsSync(ws.exportsDir)).toBe(false);
  });

  it('says so when edit/ is not there at all', async () => {
    const ws = workspace();
    rmSync(join(ws.jobDir, 'edit'), { recursive: true });
    await expect(ws.finalize(ws.job, live)).rejects.toThrow(/no edit\/final\.mp4 to export/);
  });

  it('says so when final.mp4 is empty', async () => {
    const ws = workspace();
    writeFileSync(ws.finalPath, '');
    await expect(ws.finalize(ws.job, live)).rejects.toThrow(
      'The finished video (edit/final.mp4) is empty',
    );
  });

  it('says so when final.mp4 is a folder', async () => {
    const ws = workspace();
    mkdirSync(ws.finalPath);
    await expect(ws.finalize(ws.job, live)).rejects.toThrow(
      "edit/final.mp4 is not a file, so it can't be exported",
    );
  });

  it('says so when ffprobe is not installed', async () => {
    const ws = workspace();
    writeFileSync(ws.finalPath, 'not a video');
    const finalize = createFinalize({
      inboxPath: ws.inbox,
      exportsDir: ws.exportsDir,
      ffprobeBin: join(ws.inbox, 'no-such-dir', 'ffprobe'),
    });
    await expect(finalize(ws.job, live)).rejects.toThrow(/^ffprobe was not found/);
    await expect(finalize(ws.job, live)).rejects.toThrow('brew install ffmpeg');
  });

  it('stops before looking at anything when the run was already stopped', async () => {
    const ws = workspace();
    writeFileSync(ws.finalPath, 'not a video');
    const stopped = new AbortController();
    stopped.abort();
    await expect(ws.finalize(ws.job, stopped.signal)).rejects.toThrow('The export was stopped');
    expect(existsSync(ws.exportsDir)).toBe(false);
  });

  it('throws an ExportError, not a raw system error', async () => {
    const ws = workspace();
    await expect(ws.finalize(ws.job, live)).rejects.toBeInstanceOf(ExportError);
  });
});

describe('the streamed copy', () => {
  it('copies every byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-finalize-copy-'));
    temps.push(dir);
    const source = join(dir, 'in.bin');
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 'ab');
    writeFileSync(source, bytes);

    await copyFileStreamed(source, join(dir, 'out.bin'), live);

    expect(readFileSync(join(dir, 'out.bin')).equals(bytes)).toBe(true);
  });

  it('stops when the signal fires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-finalize-copy-'));
    temps.push(dir);
    const source = join(dir, 'in.bin');
    writeFileSync(source, Buffer.alloc(8 * 1024 * 1024, 1));
    const stopped = new AbortController();
    stopped.abort();

    await expect(copyFileStreamed(source, join(dir, 'out.bin'), stopped.signal)).rejects.toThrow();
  });
});

/** Writes a small test video with ffmpeg into `target`. */
function makeVideo(
  target: string,
  { seconds = 2, size = '320x240', rotation = 0, audio = true, video = true } = {},
): void {
  const base = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
  const plain = rotation === 0 ? target : `${target}.plain.mp4`;
  const inputs = [
    ...(video ? ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${seconds}`] : []),
    ...(audio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`]
      : []),
  ];
  const codecs = [
    ...(video ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] : []),
    ...(audio ? ['-c:a', 'aac', '-b:a', '64k'] : []),
  ];
  execFileSync(ffmpeg as string, [
    ...base,
    ...inputs,
    ...codecs,
    '-shortest',
    '-movflags',
    '+faststart',
    '-y',
    plain,
  ]);
  if (rotation !== 0) {
    // A rotated clip is stored as it was filmed and carries a display matrix, like an iPhone's.
    execFileSync(ffmpeg as string, [
      ...base,
      '-display_rotation',
      String(rotation),
      '-i',
      plain,
      '-c',
      'copy',
      '-y',
      target,
    ]);
    rmSync(plain);
  }
}

describe.skipIf(!haveTools)('with ffmpeg test videos', () => {
  let clips: string;
  const clip = (name: string): string => join(clips, `${name}.mp4`);

  beforeAll(() => {
    clips = mkdtempSync(join(tmpdir(), 'studio-finalize-clips-'));
    makeVideo(clip('plain'));
    makeVideo(clip('one'), { seconds: 1 });
    makeVideo(clip('three'), { seconds: 3, size: '160x120' });
    makeVideo(clip('turned-90'), { rotation: 90 });
    makeVideo(clip('turned-minus-90'), { rotation: -90 });
    makeVideo(clip('upside-down'), { rotation: 180 });
    makeVideo(clip('audio-only'), { video: false });
  });

  afterAll(() => {
    rmSync(clips, { recursive: true, force: true });
  });

  describe('the facts', () => {
    it('reports the length, size and file size, and exports to Client/Job.mp4', async () => {
      const ws = workspace('Acme', 'Spring promo');
      ws.putFinal(clip('plain'));

      const output = await ws.finalize(ws.job, live);

      expect(output).toEqual({
        fileName: 'Acme/Spring promo.mp4',
        durationSec: expect.closeTo(2, 1),
        width: 320,
        height: 240,
        sizeBytes: statSync(ws.finalPath).size,
      });
      expect(jobOutputSchema.safeParse(output).success).toBe(true);
    });

    it('copies the video byte for byte and leaves the original where it was', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));

      const { fileName } = await ws.finalize(ws.job, live);

      const exported = join(ws.exportsDir, fileName);
      expect(readFileSync(exported).equals(readFileSync(clip('plain')))).toBe(true);
      expect(readFileSync(ws.finalPath).equals(readFileSync(clip('plain')))).toBe(true);
    });

    it('makes the client folder, and nothing is left beside the export', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      expect(existsSync(ws.exportsDir)).toBe(false);

      await ws.finalize(ws.job, live);

      expect(readdirSync(ws.clientDir)).toEqual(['Spring promo.mp4']);
    });

    it('exports into a folder outside the inbox, with the name relative to that folder', async () => {
      const ws = workspace('Acme', 'Spring promo', { exportsOutside: true });
      ws.putFinal(clip('plain'));

      const { fileName } = await ws.finalize(ws.job, live);

      expect(fileName).toBe('Acme/Spring promo.mp4');
      expect(existsSync(join(ws.exportsDir, 'Acme', 'Spring promo.mp4'))).toBe(true);
      expect(existsSync(join(ws.inbox, '_Exports'))).toBe(false);
    });

    it.each([
      ['turned-90', 'a quarter turn'],
      ['turned-minus-90', 'a quarter turn the other way'],
    ])('swaps width and height for a clip stored on its side (%s: %s)', async (name) => {
      const ws = workspace();
      ws.putFinal(clip(name));

      const output = await ws.finalize(ws.job, live);

      expect(output).toMatchObject({ width: 240, height: 320 });
    });

    it('keeps the size of an upside-down clip', async () => {
      const ws = workspace();
      ws.putFinal(clip('upside-down'));

      expect(await ws.finalize(ws.job, live)).toMatchObject({ width: 320, height: 240 });
    });
  });

  describe('names', () => {
    it('keeps Hebrew client and job names in the path', async () => {
      const ws = workspace('לקוח א', 'סרטון אביב');
      ws.putFinal(clip('plain'));

      const output = await ws.finalize(ws.job, live);

      expect(output.fileName).toBe('לקוח א/סרטון אביב.mp4');
      expect(readdirSync(ws.exportsDir)).toEqual(['לקוח א']);
      expect(readdirSync(join(ws.exportsDir, 'לקוח א'))).toEqual(['סרטון אביב.mp4']);
      expect(statSync(join(ws.exportsDir, output.fileName)).size).toBe(output.sizeBytes);
    });

    it('keeps emoji, and a Hebrew name with Latin letters, digits and punctuation', async () => {
      const ws = workspace('Café ☕ בע"מ', 'אביב 2026 – v2 🌸');
      ws.putFinal(clip('plain'));

      const output = await ws.finalize(ws.job, live);

      expect(output.fileName).toBe('Café ☕ בע"מ/אביב 2026 – v2 🌸.mp4');
      expect(existsSync(join(ws.exportsDir, output.fileName))).toBe(true);
    });

    it('writes an accented name in NFC even when the folder was spelled in NFD', async () => {
      const ws = workspace('Café Noir', 'Menu');
      ws.putFinal(clip('plain'));

      const output = await ws.finalize(ws.job, live);

      expect(output.fileName).toBe('Café Noir/Menu.mp4');
      expect(existsSync(join(ws.exportsDir, output.fileName))).toBe(true);
    });

    it('replaces a colon in the job name', async () => {
      const ws = workspace('Acme', 'Promo: spring');
      ws.putFinal(clip('plain'));

      const output = await ws.finalize(ws.job, live);

      expect(output.fileName).toBe('Acme/Promo- spring.mp4');
      expect(existsSync(join(ws.exportsDir, 'Acme', 'Promo- spring.mp4'))).toBe(true);
    });

    it('a client named like the exports folder is just another client', async () => {
      const ws = workspace('_Exports', 'Odd one');
      ws.putFinal(clip('plain'));

      const output = await ws.finalize(ws.job, live);

      expect(output.fileName).toBe('_Exports/Odd one.mp4');
    });
  });

  describe('when the export already exists', () => {
    it('moves the old one to (1) and takes the plain name', async () => {
      const ws = workspace();
      ws.putFinal(clip('one'));
      await ws.finalize(ws.job, live);
      ws.putFinal(clip('plain'));

      const output = await ws.finalize(ws.job, live);

      expect(output.fileName).toBe('Acme/Spring promo.mp4');
      expect(readdirSync(ws.clientDir).sort()).toEqual([
        'Spring promo (1).mp4',
        'Spring promo.mp4',
      ]);
      const bytes = (name: string) => readFileSync(join(ws.clientDir, name));
      expect(bytes('Spring promo.mp4').equals(readFileSync(clip('plain')))).toBe(true);
      expect(bytes('Spring promo (1).mp4').equals(readFileSync(clip('one')))).toBe(true);
    });

    it('keeps counting: (1), (2), ... with the newest always on the plain name', async () => {
      const ws = workspace();
      const order = ['one', 'plain', 'three'];
      for (const name of order) {
        ws.putFinal(clip(name));
        await ws.finalize(ws.job, live);
      }

      expect(readdirSync(ws.clientDir).sort()).toEqual([
        'Spring promo (1).mp4',
        'Spring promo (2).mp4',
        'Spring promo.mp4',
      ]);
      const same = (name: string, clipName: string): boolean =>
        readFileSync(join(ws.clientDir, name)).equals(readFileSync(clip(clipName)));
      expect(same('Spring promo.mp4', 'three')).toBe(true);
      expect(same('Spring promo (2).mp4', 'plain')).toBe(true);
      expect(same('Spring promo (1).mp4', 'one')).toBe(true);
    });

    it('moves the old one to the first free number', async () => {
      const ws = workspace();
      mkdirSync(ws.clientDir, { recursive: true });
      writeFileSync(join(ws.clientDir, 'Spring promo.mp4'), 'old');
      writeFileSync(join(ws.clientDir, 'Spring promo (2).mp4'), 'older');
      ws.putFinal(clip('plain'));

      await ws.finalize(ws.job, live);

      expect(readdirSync(ws.clientDir).sort()).toEqual([
        'Spring promo (1).mp4',
        'Spring promo (2).mp4',
        'Spring promo.mp4',
      ]);
      expect(readFileSync(join(ws.clientDir, 'Spring promo (1).mp4'), 'utf8')).toBe('old');
      expect(readFileSync(join(ws.clientDir, 'Spring promo (2).mp4'), 'utf8')).toBe('older');
    });

    it('numbers Hebrew names the same way', async () => {
      const ws = workspace('לקוח א', 'סרטון אביב');
      for (const name of ['one', 'plain']) {
        ws.putFinal(clip(name));
        await ws.finalize(ws.job, live);
      }

      expect(readdirSync(ws.clientDir).sort()).toEqual(['סרטון אביב (1).mp4', 'סרטון אביב.mp4']);
    });

    it('does not touch exports of other jobs of the same client', async () => {
      const first = workspace('Acme', 'Spring promo');
      first.putFinal(clip('one'));
      await first.finalize(first.job, live);
      const other = jobFor('Acme', 'Autumn promo');
      const otherJobDir = join(first.inbox, other.relPath, 'edit');
      mkdirSync(otherJobDir, { recursive: true });
      copyFileSync(clip('plain'), join(otherJobDir, 'final.mp4'));

      await first.finalize(other, live);

      expect(readdirSync(first.clientDir).sort()).toEqual(['Autumn promo.mp4', 'Spring promo.mp4']);
    });

    it('refuses when a folder has the video file name, and leaves it alone', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      mkdirSync(join(ws.clientDir, 'Spring promo.mp4'), { recursive: true });

      await expect(ws.finalize(ws.job, live)).rejects.toThrow(
        'Acme/Spring promo.mp4 is already there and is not a video file',
      );

      expect(readdirSync(ws.clientDir)).toEqual(['Spring promo.mp4']);
      expect(statSync(join(ws.clientDir, 'Spring promo.mp4')).isDirectory()).toBe(true);
    });
  });

  describe('a half-copied file never shows up', () => {
    /** A copy that gives the test a look at the folder half way, then does what `after` says. */
    function copyThatPeeks(
      peek: (target: string) => void,
      after: (source: string, target: string, signal: AbortSignal) => Promise<void>,
    ): CopyFile {
      return async (source, target, signal) => {
        const bytes = readFileSync(source);
        writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)));
        peek(target);
        await after(source, target, signal);
      };
    }

    function withCopy(ws: Workspace, copyFile: CopyFile) {
      return createFinalize({ inboxPath: ws.inbox, exportsDir: ws.exportsDir, copyFile });
    }

    it('copies under a hidden name and only then renames it into place', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      const seen: Array<{ entries: string[]; targetHidden: boolean }> = [];
      const finalize = withCopy(
        ws,
        copyThatPeeks(
          (target) => {
            seen.push({
              entries: readdirSync(dirname(target)),
              targetHidden: target.split('/').pop()?.startsWith('.') === true,
            });
            expect(visible(dirname(target))).toEqual([]);
          },
          async (source, target) => copyFileSync(source, target),
        ),
      );

      const output = await finalize(ws.job, live);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.targetHidden).toBe(true);
      expect(seen[0]?.entries).toEqual([`.${ws.job.id}.mp4.partial`]);
      expect(readdirSync(ws.clientDir)).toEqual(['Spring promo.mp4']);
      expect(statSync(join(ws.exportsDir, output.fileName)).size).toBe(output.sizeBytes);
    });

    it('leaves the earlier export as it was while the new one is being copied', async () => {
      const ws = workspace();
      ws.putFinal(clip('one'));
      await ws.finalize(ws.job, live);
      ws.putFinal(clip('plain'));
      const during: string[] = [];
      const finalize = withCopy(
        ws,
        copyThatPeeks(
          () => {
            during.push(...visible(ws.clientDir));
            expect(
              readFileSync(join(ws.clientDir, 'Spring promo.mp4')).equals(
                readFileSync(clip('one')),
              ),
            ).toBe(true);
          },
          async (source, target) => copyFileSync(source, target),
        ),
      );

      await finalize(ws.job, live);

      expect(during).toEqual(['Spring promo.mp4']);
    });

    it('removes the partial file and keeps the earlier export when the disk is full', async () => {
      const ws = workspace();
      ws.putFinal(clip('one'));
      await ws.finalize(ws.job, live);
      ws.putFinal(clip('plain'));
      const finalize = withCopy(
        ws,
        copyThatPeeks(
          () => {},
          async () => {
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
              code: 'ENOSPC',
            });
          },
        ),
      );

      await expect(finalize(ws.job, live)).rejects.toThrow(
        'Not enough disk space to copy the video to _Exports',
      );

      expect(readdirSync(ws.clientDir)).toEqual(['Spring promo.mp4']);
      expect(
        readFileSync(join(ws.clientDir, 'Spring promo.mp4')).equals(readFileSync(clip('one'))),
      ).toBe(true);
    });

    it('removes the partial file when the export is stopped half way', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      const stop = new AbortController();
      let started: () => void = () => {};
      const copying = new Promise<void>((resolve) => {
        started = resolve;
      });
      const finalize = withCopy(
        ws,
        copyThatPeeks(
          () => started(),
          (_source, _target, signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        ),
      );

      const running = finalize(ws.job, stop.signal);
      await copying;
      expect(readdirSync(ws.clientDir)).toEqual([`.${ws.job.id}.mp4.partial`]);
      stop.abort();

      await expect(running).rejects.toThrow('The export was stopped');
      expect(readdirSync(ws.clientDir)).toEqual([]);
    });

    it('does not rename into place when the signal fired as the copy ended', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      const stop = new AbortController();
      const finalize = withCopy(ws, async (source, target) => {
        copyFileSync(source, target);
        stop.abort();
      });

      await expect(finalize(ws.job, stop.signal)).rejects.toThrow('The export was stopped');
      expect(readdirSync(ws.clientDir)).toEqual([]);
    });

    it('refuses a copy that is shorter than the video', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      const finalize = withCopy(
        ws,
        copyThatPeeks(
          () => {},
          async () => {},
        ),
      );
      const size = statSync(ws.finalPath).size;

      await expect(finalize(ws.job, live)).rejects.toThrow(
        `The copy of the video is incomplete (${Math.floor(size / 2)} of ${size} bytes)`,
      );
      expect(readdirSync(ws.clientDir)).toEqual([]);
    });

    it('replaces the leftover partial file of an export that crashed', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      mkdirSync(ws.clientDir, { recursive: true });
      writeFileSync(join(ws.clientDir, `.${ws.job.id}.mp4.partial`), 'half of something');

      await ws.finalize(ws.job, live);

      expect(readdirSync(ws.clientDir)).toEqual(['Spring promo.mp4']);
      expect(
        readFileSync(join(ws.clientDir, 'Spring promo.mp4')).equals(readFileSync(clip('plain'))),
      ).toBe(true);
    });
  });

  describe('readable errors', () => {
    it("says when final.mp4 can't be read as a video", async () => {
      const ws = workspace();
      writeFileSync(ws.finalPath, 'this is a text file with an .mp4 name');

      const error = await ws.finalize(ws.job, live).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(error?.message).toMatch(/^The finished video can't be read \(ffprobe: .+\)$/);
      expect(error?.message).not.toContain(ws.inbox);
      expect(existsSync(ws.exportsDir)).toBe(false);
    });

    it('says when final.mp4 is only the first few bytes of a video', async () => {
      const ws = workspace();
      writeFileSync(ws.finalPath, readFileSync(clip('plain')).subarray(0, 40));

      await expect(ws.finalize(ws.job, live)).rejects.toThrow(
        /^The finished video (can't be read|has no picture)/,
      );
      expect(existsSync(ws.exportsDir)).toBe(false);
    });

    it('says when the video has sound only', async () => {
      const ws = workspace();
      ws.putFinal(clip('audio-only'));

      await expect(ws.finalize(ws.job, live)).rejects.toThrow(
        'The finished video has no picture (no video track in it)',
      );
    });

    it('says when a file is where the client folder should be', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      mkdirSync(ws.exportsDir, { recursive: true });
      writeFileSync(join(ws.exportsDir, 'Acme'), 'in the way');

      await expect(ws.finalize(ws.job, live)).rejects.toThrow(
        "Can't make the client folder in _Exports: a file has the same name",
      );
    });

    it('says when it may not write to the exports folder', async () => {
      const ws = workspace();
      ws.putFinal(clip('plain'));
      mkdirSync(ws.exportsDir, { recursive: true });
      // Read and search, but no write: the client folder cannot be made.
      chmodSync(ws.exportsDir, 0o555);
      try {
        // root ignores the mode (CI containers); there is nothing to see then.
        if (process.getuid?.() === 0) return;
        await expect(ws.finalize(ws.job, live)).rejects.toThrow(
          'No permission to write to _Exports',
        );
      } finally {
        chmodSync(ws.exportsDir, 0o755);
      }
    });
  });
});
