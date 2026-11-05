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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Job, jobFormatsOf, jobOutputSchema } from '@studio/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { resolveFfmpeg } from './fake-media.js';
import { type CopyFile, copyFileStreamed, createFinalize, exportRelPath } from './finalize.js';

// Formats (GN7): the export of a render run of a job with two or more formats puts a file for each
// in the exports folder, by the same rules as the single export. A job with one format, and an edit
// run, export one file exactly as before (finalize.test.ts keeps pinning that).

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
const live = new AbortController().signal;

let db: StudioDb;
let jobs: JobRepository;
let clips: string;
const temps: string[] = [];

beforeAll(() => {
  db = memoryDb();
  jobs = new JobRepository(db);
  if (!haveTools) return;
  clips = mkdtempSync(join(tmpdir(), 'studio-finalize-formats-clips-'));
  makeVideo(join(clips, 'main.mp4'), '216x384', 2);
  makeVideo(join(clips, 'square.mp4'), '240x240', 2);
  makeVideo(join(clips, 'older.mp4'), '216x384', 1);
});

afterAll(() => {
  if (db.sqlite.open) db.close();
  if (clips !== undefined) rmSync(clips, { recursive: true, force: true });
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeVideo(target: string, size: string, seconds: number): void {
  execFileSync(ffmpeg as string, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=25:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    target,
  ]);
}

interface Workspace {
  inbox: string;
  exportsDir: string;
  clientDir: string;
  /** The job as a render run of a job with these formats leaves it. */
  job: Job;
  jobDir: string;
  finalize: ReturnType<typeof createFinalize>;
  put(relPath: string, clip: string): void;
}

function workspace(
  canvases: string[] | null = ['1080x1920', '1080x1080'],
  runKind: Job['runKind'] = 'render',
  copyFile?: CopyFile,
): Workspace {
  const base = mkdtempSync(join(tmpdir(), 'studio-finalize-formats-'));
  temps.push(base);
  const inbox = join(base, 'inbox');
  const exportsDir = join(inbox, '_Exports');
  const scanned = jobs.upsertFromScan(makeScan('Acme', `Teaser ${temps.length}`)).job;
  const formats = jobFormatsOf(canvases);
  const job: Job = {
    ...scanned,
    runKind,
    ...(formats.length === 0 ? {} : { formats }),
  };
  const jobDir = join(inbox, job.relPath);
  mkdirSync(join(jobDir, 'edit'), { recursive: true });
  return {
    inbox,
    exportsDir,
    clientDir: join(exportsDir, 'Acme'),
    job,
    jobDir,
    finalize: createFinalize({ inboxPath: inbox, exportsDir, ...(copyFile ? { copyFile } : {}) }),
    put: (relPath, clip) => copyFileSync(join(clips, clip), join(jobDir, relPath)),
  };
}

const visible = (dir: string): string[] =>
  readdirSync(dir)
    .filter((entry) => !entry.startsWith('.'))
    .sort();

describe('export names of a format', () => {
  it('is the plain name for the main format and "(id)" before the extension for an extra one', () => {
    const job = { client: 'Acme', name: 'Teaser' };
    expect(exportRelPath(job)).toBe('Acme/Teaser.mp4');
    expect(exportRelPath(job, '1x1')).toBe('Acme/Teaser (1x1).mp4');
    expect(exportRelPath({ client: 'לקוח: א', name: 'סרטון/אביב' }, '4x5')).toBe(
      'לקוח- א/סרטון-אביב (4x5).mp4',
    );
  });
});

describe('errors that need no video tools', () => {
  it('says which format’s video is missing', async () => {
    const ws = workspace();
    writeFileSync(join(ws.jobDir, 'edit', 'final.mp4'), 'x');
    await expect(ws.finalize(ws.job, live)).rejects.toThrow(
      'The edit finished but there is no edit/final-1x1.mp4 to export',
    );
  });

  it('exports nothing when the extra format’s video is empty', async () => {
    const ws = workspace();
    writeFileSync(join(ws.jobDir, 'edit', 'final.mp4'), 'x');
    writeFileSync(join(ws.jobDir, 'edit', 'final-1x1.mp4'), '');
    await expect(ws.finalize(ws.job, live)).rejects.toThrow(
      'The finished video (edit/final-1x1.mp4) is empty',
    );
    expect(existsSync(ws.exportsDir)).toBe(false);
  });
});

describe.skipIf(!haveTools)('with ffmpeg test videos', () => {
  it('exports both files, the main one with the facts of JobOutput and an outputs entry for each', async () => {
    const ws = workspace();
    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');

    const output = await ws.finalize(ws.job, live);

    expect(visible(ws.clientDir)).toEqual([`${ws.job.name} (1x1).mp4`, `${ws.job.name}.mp4`]);
    const main = `Acme/${ws.job.name}.mp4`;
    const square = `Acme/${ws.job.name} (1x1).mp4`;
    expect(output.fileName).toBe(main);
    expect(output.width).toBe(216);
    expect(output.height).toBe(384);
    expect(output.durationSec).toBeCloseTo(2, 0);
    const mainBytes = readFileSync(join(ws.exportsDir, main));
    const squareBytes = readFileSync(join(ws.exportsDir, square));
    expect(mainBytes.equals(readFileSync(join(clips, 'main.mp4')))).toBe(true);
    expect(squareBytes.equals(readFileSync(join(clips, 'square.mp4')))).toBe(true);
    expect(output.sizeBytes).toBe(mainBytes.length);
    expect(output.outputs).toEqual([
      { format: '9x16', fileName: main, bytes: mainBytes.length },
      { format: '1x1', fileName: square, bytes: squareBytes.length },
    ]);
    // What the machine stores and the API sends is valid.
    expect(jobOutputSchema.parse(output)).toEqual(output);
    // The source videos stay (a copy, not a move), and no hidden partial is left.
    expect(existsSync(join(ws.jobDir, 'edit', 'final-1x1.mp4'))).toBe(true);
    expect(readdirSync(ws.clientDir).filter((entry) => entry.startsWith('.'))).toEqual([]);
  });

  it('exports one file, as before, for a job with one format or none: no outputs key at all', async () => {
    for (const canvases of [null, ['1080x1920'], ['1080x1920', '1080x1920']]) {
      const ws = workspace(canvases);
      ws.put('edit/final.mp4', 'main.mp4');
      const output = await ws.finalize(ws.job, live);
      expect(Object.keys(output).sort()).toEqual([
        'durationSec',
        'fileName',
        'height',
        'sizeBytes',
        'width',
      ]);
      expect(visible(ws.clientDir)).toEqual([`${ws.job.name}.mp4`]);
    }
  });

  it('exports only the main video for an edit run (Review off), whatever lies in edit/', async () => {
    const ws = workspace(['1080x1920', '1080x1080'], 'edit');
    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');
    const output = await ws.finalize(ws.job, live);
    expect(output.outputs).toBeUndefined();
    expect(visible(ws.clientDir)).toEqual([`${ws.job.name}.mp4`]);
  });

  it('moves each older export to its own first free (n), the newest on the plain names', async () => {
    const ws = workspace();
    ws.put('edit/final.mp4', 'older.mp4');
    ws.put('edit/final-1x1.mp4', 'older.mp4');
    await ws.finalize(ws.job, live);
    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');
    await ws.finalize(ws.job, live);
    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');
    await ws.finalize(ws.job, live);

    const name = ws.job.name;
    expect(visible(ws.clientDir)).toEqual(
      [
        `${name} (1).mp4`,
        `${name} (1x1) (1).mp4`,
        `${name} (1x1) (2).mp4`,
        `${name} (1x1).mp4`,
        `${name} (2).mp4`,
        `${name}.mp4`,
      ].sort(),
    );
    const same = (file: string, clip: string): boolean =>
      readFileSync(join(ws.clientDir, file)).equals(readFileSync(join(clips, clip)));
    // The oldest is (1), the one before the newest is (2), the newest has the plain name.
    expect(same(`${name} (1x1) (1).mp4`, 'older.mp4')).toBe(true);
    expect(same(`${name} (1x1) (2).mp4`, 'square.mp4')).toBe(true);
    expect(same(`${name} (1x1).mp4`, 'square.mp4')).toBe(true);
    expect(same(`${name} (1).mp4`, 'older.mp4')).toBe(true);
    expect(same(`${name} (2).mp4`, 'main.mp4')).toBe(true);
    expect(same(`${name}.mp4`, 'main.mp4')).toBe(true);
  });

  it('exports nothing when the second video is not a video, and leaves the earlier exports alone', async () => {
    const first = workspace();
    first.put('edit/final.mp4', 'older.mp4');
    first.put('edit/final-1x1.mp4', 'older.mp4');
    await first.finalize(first.job, live);

    first.put('edit/final.mp4', 'main.mp4');
    writeFileSync(join(first.jobDir, 'edit', 'final-1x1.mp4'), 'not a video');
    await expect(first.finalize(first.job, live)).rejects.toThrow();

    const name = first.job.name;
    expect(visible(first.clientDir)).toEqual([`${name} (1x1).mp4`, `${name}.mp4`]);
    expect(
      readFileSync(join(first.clientDir, `${name}.mp4`)).equals(
        readFileSync(join(clips, 'older.mp4')),
      ),
    ).toBe(true);
  });

  it('takes the first file back out when the second one cannot be copied', async () => {
    let copies = 0;
    const failing: CopyFile = async (source, target, signal) => {
      copies += 1;
      if (copies === 2) throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
      await copyFileStreamed(source, target, signal);
    };
    const ws = workspace(['1080x1920', '1080x1080'], 'render', failing);
    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');

    await expect(ws.finalize(ws.job, live)).rejects.toThrow(/Not enough disk space/);

    // The copies come before anything is put in place, so no export and no partial is left.
    expect(readdirSync(ws.clientDir)).toEqual([]);
  });

  it('puts the earlier exports back when the second file cannot take its name', async () => {
    const ws = workspace();
    ws.put('edit/final.mp4', 'older.mp4');
    ws.put('edit/final-1x1.mp4', 'older.mp4');
    await ws.finalize(ws.job, live);
    // The extra export's name is now a folder, so it cannot be moved aside.
    const name = ws.job.name;
    rmSync(join(ws.clientDir, `${name} (1x1).mp4`));
    mkdirSync(join(ws.clientDir, `${name} (1x1).mp4`));

    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');
    await expect(ws.finalize(ws.job, live)).rejects.toThrow(
      /is already there and is not a video file/,
    );

    // The main export was put in place first and is taken back out: the older one is as it was.
    expect(visible(ws.clientDir)).toEqual([`${name} (1x1).mp4`, `${name}.mp4`]);
    expect(
      readFileSync(join(ws.clientDir, `${name}.mp4`)).equals(
        readFileSync(join(clips, 'older.mp4')),
      ),
    ).toBe(true);
    expect(readdirSync(ws.clientDir).filter((entry) => entry.startsWith('.'))).toEqual([]);
  });

  it('stops without a trace when the signal fires during the copies', async () => {
    const stopped = new AbortController();
    const slow: CopyFile = async (source, target, signal) => {
      await copyFileStreamed(source, target, signal);
      stopped.abort();
    };
    const ws = workspace(['1080x1920', '1080x1080'], 'render', slow);
    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');
    await expect(ws.finalize(ws.job, stopped.signal)).rejects.toThrow('The export was stopped');
    expect(readdirSync(ws.clientDir)).toEqual([]);
  });

  it('keeps a read-only exports folder’s message for the extra file too', async () => {
    const ws = workspace();
    ws.put('edit/final.mp4', 'main.mp4');
    ws.put('edit/final-1x1.mp4', 'square.mp4');
    mkdirSync(ws.clientDir, { recursive: true });
    chmodSync(ws.clientDir, 0o555);
    try {
      await expect(ws.finalize(ws.job, live)).rejects.toThrow(/No permission to write to _Exports/);
    } finally {
      chmodSync(ws.clientDir, 0o755);
    }
  });
});
