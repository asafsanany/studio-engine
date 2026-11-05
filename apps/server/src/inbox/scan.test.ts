import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { inputCountsSchema } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useClientRegistry } from './client-registry.js';
import { DurationCache, type ProbeDuration } from './probe.js';
import {
  clientIdFor,
  ensureStyleDir,
  isClientFolder,
  isClientFolderName,
  jobIdFor,
  jobRelPath,
  listClientNames,
  listJobFiles,
  scanInbox,
  scanJob,
  seriesIdFor,
} from './scan.js';

// Every test builds its own tree under a temp dir. The real ~/Studio Inbox is never touched.
let inbox: string;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-scan-'));
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

/** Writes a file of the given size, making folders as needed. Paths are relative to the inbox. */
function file(relPath: string, bytes = 1): string {
  const path = join(inbox, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

function dir(relPath: string): string {
  const path = join(inbox, relPath);
  mkdirSync(path, { recursive: true });
  return path;
}

function setMtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

/** A prober that answers from a table keyed by file name and records every call. */
function fakeProbe(durations: Record<string, number | null | 'throw'> = {}) {
  const calls: string[] = [];
  const probe: ProbeDuration = async (path) => {
    calls.push(path);
    const answer = durations[basename(path)];
    if (answer === 'throw') throw new Error('probe failed');
    return answer ?? null;
  };
  return { calls, durations: new DurationCache(probe) };
}

const sha1Id = (relPath: string) =>
  createHash('sha1').update(relPath.normalize('NFC'), 'utf8').digest('hex').slice(0, 12);

describe('scanInbox: a plain job', () => {
  it('counts files by kind, in any case, across nested folders', async () => {
    file('Acme/Spring Launch/a.mp4', 100);
    file('Acme/Spring Launch/B.MOV', 200);
    file('Acme/Spring Launch/voice.m4a', 50);
    file('Acme/Spring Launch/logo.PNG', 10);
    file('Acme/Spring Launch/brief.pdf', 5);
    file('Acme/Spring Launch/mystery.xyz', 7);
    file('Acme/Spring Launch/raw/day2/c.mp4', 300);
    file('Acme/Spring Launch/raw/day2/take.wav', 40);
    file('Acme/Spring Launch/raw/day2/photos/p1.heic', 20);
    file('Acme/Spring Launch/raw/day2/photos/p2.jpeg', 30);

    const { durations } = fakeProbe();
    const jobs = await scanInbox(inbox, { durations });

    expect(jobs).toEqual([
      {
        id: sha1Id('Acme/Spring Launch'),
        client: 'Acme',
        name: 'Spring Launch',
        relPath: 'Acme/Spring Launch',
        absPath: join(inbox, 'Acme', 'Spring Launch'),
        inputs: { video: 3, audio: 2, image: 3, doc: 1 },
        // Unknown types count toward size only.
        sizeBytes: 100 + 200 + 50 + 10 + 5 + 7 + 300 + 40 + 20 + 30,
        footageSec: 0,
        newestMtimeMs: expect.any(Number),
      },
    ]);
  });

  it('always returns all four InputCounts keys, also for an empty job', async () => {
    dir('Acme/Empty');
    file('Acme/Only Notes/todo.txt', 3);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });
    const byName = Object.fromEntries(jobs.map((job) => [job.name, job]));

    expect(byName.Empty?.inputs).toEqual({ video: 0, audio: 0, image: 0, doc: 0 });
    expect(byName.Empty?.sizeBytes).toBe(0);
    expect(byName.Empty?.footageSec).toBe(0);
    expect(byName.Empty?.newestMtimeMs).toBe(0);
    expect(byName['Only Notes']?.inputs).toEqual({ video: 0, audio: 0, image: 0, doc: 1 });
    for (const job of jobs) {
      expect(inputCountsSchema.parse(job.inputs)).toEqual(job.inputs);
    }
  });

  it('sorts jobs by relPath', async () => {
    dir('Zed/Job B');
    dir('Acme/Job 2');
    dir('Acme/Job 10');
    dir('Acme/Job 1');

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(jobs.map((job) => job.relPath)).toEqual([
      'Acme/Job 1',
      'Acme/Job 10',
      'Acme/Job 2',
      'Zed/Job B',
    ]);
  });

  it('gives an inbox that does not exist no jobs', async () => {
    expect(await scanInbox(join(inbox, 'nope'))).toEqual([]);
  });
});

describe('scanInbox: names and ids', () => {
  it('keeps Hebrew and emoji names exactly and hashes the relPath', async () => {
    file('לקוח א׳/סרטון חדש 🎬/clip.mp4', 10);
    file('לקוח א׳/סרטון חדש 🎬/קול.m4a', 5);
    file('Café ☕/הדגמה — v2/shot.MOV', 8);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });

    const hebrew = jobs.find((job) => job.client === 'לקוח א׳');
    expect(hebrew).toMatchObject({
      client: 'לקוח א׳',
      name: 'סרטון חדש 🎬',
      relPath: 'לקוח א׳/סרטון חדש 🎬',
      id: sha1Id('לקוח א׳/סרטון חדש 🎬'),
      inputs: { video: 1, audio: 1, image: 0, doc: 0 },
      sizeBytes: 15,
    });
    expect(hebrew?.absPath).toBe(join(inbox, 'לקוח א׳', 'סרטון חדש 🎬'));
    expect(hebrew?.id).toMatch(/^[0-9a-f]{12}$/);

    const mixed = jobs.find((job) => job.client === 'Café ☕');
    expect(mixed?.name).toBe('הדגמה — v2');
  });

  it('gives the same id to NFC and NFD spellings of a name, and keeps the listed spelling', async () => {
    const nfc = 'Café/Señal';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(jobIdFor(nfd)).toBe(jobIdFor(nfc));
    expect(jobIdFor(nfc)).toBe(sha1Id(nfc));

    file(`${nfd}/clip.mp4`, 4);
    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });

    // The file system may hand the name back as NFD or NFC; either way the id is the same.
    expect(job?.relPath.normalize('NFC')).toBe(nfc);
    expect(job?.id).toBe(jobIdFor(nfc));
    expect(job?.relPath).toBe(`${job?.client}/${job?.name}`);
  });

  it('is case sensitive and builds the id from Client/Job only', () => {
    expect(jobIdFor('Acme/Spring')).not.toBe(jobIdFor('acme/spring'));
    expect(jobIdFor('Acme/Spring')).not.toBe(jobIdFor('Acme/Spring2'));
    expect(jobIdFor('Acme/Spring')).toBe(sha1Id('Acme/Spring'));
    expect(jobRelPath('Acme', 'Spring')).toBe('Acme/Spring');
  });
});

describe('scanInbox: what is a job', () => {
  it('only takes folders exactly two levels down', async () => {
    file('loose.mp4', 9);
    file('Acme/loose-in-client.mp4', 9);
    file('Acme/Real Job/clip.mp4', 9);
    file('Acme/Real Job/sub/Deep/clip.mp4', 9);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Real Job']);
    // The deeper folder is just a subfolder of the job.
    expect(jobs[0]?.inputs.video).toBe(2);
  });

  it('skips _Exports, _Fonts, dot-folders and the configured exports folder', async () => {
    file('Acme/Job/clip.mp4');
    file('_Exports/Acme/Job.mp4');
    dir('_Exports/Acme/Job');
    file('_Fonts/Heebo/Heebo-Bold.ttf');
    dir('_Fonts/Rubik');
    dir('.hidden/Job');
    dir('.Trashes/Job');
    dir('Acme/.cache');
    dir('Beta/.stash');
    dir('Beta/Visible');
    dir('Finished/Acme/Job');
    dir('Acme/out');

    const jobs = await scanInbox(inbox, {
      exportsDir: join(inbox, 'Finished'),
      durations: fakeProbe().durations,
    });
    // `Acme/out` is a job here: only the configured folder is skipped, not every folder called out.
    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Job', 'Acme/out', 'Beta/Visible']);

    const nested = await scanInbox(inbox, {
      exportsDir: join(inbox, 'Acme', 'out'),
      durations: fakeProbe().durations,
    });
    expect(nested.map((job) => job.relPath)).toEqual(['Acme/Job', 'Beta/Visible', 'Finished/Acme']);
  });

  it('recognises the configured exports folder despite a trailing slash or other Unicode form', async () => {
    dir('Acme/Job');
    dir('Café/exports');

    const jobs = await scanInbox(inbox, {
      exportsDir: `${join(inbox, 'Café', 'exports')}/`,
      durations: fakeProbe().durations,
    });
    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Job']);
  });

  it('leaves out an exports folder that sits inside a job', async () => {
    file('Acme/Job/clip.mp4', 10);
    file('Acme/Job/renders/final.mp4', 999);

    const [job] = await scanInbox(inbox, {
      exportsDir: join(inbox, 'Acme', 'Job', 'renders'),
      durations: fakeProbe().durations,
    });
    expect(job).toMatchObject({ inputs: { video: 1, audio: 0, image: 0, doc: 0 }, sizeBytes: 10 });
  });

  it('does not follow symlinked folders, at any level', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-scan-elsewhere-'));
    try {
      writeFileSync(join(elsewhere, 'big.mp4'), 'x'.repeat(500));

      file('Acme/Job/clip.mp4', 10);
      symlinkSync(elsewhere, join(inbox, 'Linked Client'));
      symlinkSync(elsewhere, join(inbox, 'Acme', 'Linked Job'));
      symlinkSync(elsewhere, join(inbox, 'Acme', 'Job', 'linked-folder'));
      // A link back up the tree must not make the walk loop.
      symlinkSync(inbox, join(inbox, 'Acme', 'Job', 'loop'));

      const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });
      expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Job']);
      expect(jobs[0]).toMatchObject({
        inputs: { video: 1, audio: 0, image: 0, doc: 0 },
        sizeBytes: 10,
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('counts a symlinked file as the file it points to and ignores a broken link', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-scan-elsewhere-'));
    try {
      const target = join(elsewhere, 'source.mov');
      writeFileSync(target, 'x'.repeat(120));
      dir('Acme/Job');
      symlinkSync(target, join(inbox, 'Acme', 'Job', 'alias.mov'));
      symlinkSync(join(elsewhere, 'gone.mov'), join(inbox, 'Acme', 'Job', 'broken.mov'));

      const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
      expect(job).toMatchObject({
        inputs: { video: 1, audio: 0, image: 0, doc: 0 },
        sizeBytes: 120,
      });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('scanInbox: what is skipped inside a job', () => {
  it('does not count anything under edit/', async () => {
    file('Acme/Job/clip.mp4', 100);
    file('Acme/Job/voice.wav', 10);
    file('Acme/Job/edit/final.mp4', 5000);
    file('Acme/Job/edit/preview.mp4', 4000);
    file('Acme/Job/edit/master.wav', 3000);
    file('Acme/Job/edit/frames/a.png', 20);
    file('Acme/Job/edit/transcripts/clip.json', 30);
    file('Acme/Job/edit/project.md', 40);
    file('Acme/Job/edit/animations/slot_1/render.mov', 50);

    const { calls, durations } = fakeProbe({ 'clip.mp4': 10, 'voice.wav': 2 });
    const [job] = await scanInbox(inbox, { durations });

    expect(job).toMatchObject({
      inputs: { video: 1, audio: 1, image: 0, doc: 0 },
      sizeBytes: 110,
      footageSec: 12,
    });
    expect(calls.map((path) => basename(path)).sort()).toEqual(['clip.mp4', 'voice.wav']);
  });

  it('skips edit/ whatever its case, and a job with only an edit/ folder is empty', async () => {
    file('Acme/Only Edit/Edit/final.mp4', 500);
    file('Acme/Only Edit/EDIT/more.mp4', 500);

    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(job).toMatchObject({
      inputs: { video: 0, audio: 0, image: 0, doc: 0 },
      sizeBytes: 0,
      newestMtimeMs: 0,
    });
  });

  it('skips only the edit/ workspace at the job root: a folder called edit deeper down is client material', async () => {
    file('Acme/Job/raw/edit/clip.mp4', 70);
    file('Acme/Job/raw/edit/edit/clip2.mp4', 30);

    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(job).toMatchObject({ inputs: { video: 2, audio: 0, image: 0, doc: 0 }, sizeBytes: 100 });
  });

  it('counts a file named edit at the job root, since only the folder is the workspace', async () => {
    file('Acme/Job/edit', 12);

    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(job?.sizeBytes).toBe(12);
  });

  it('skips dotfiles, dot-folders and .DS_Store at any depth', async () => {
    file('Acme/Job/clip.mp4', 10);
    file('Acme/Job/.DS_Store', 6000);
    file('Acme/Job/._clip.mp4', 4000);
    file('Acme/Job/.hidden/secret.mp4', 3000);
    file('Acme/Job/raw/.DS_Store', 2000);
    file('Acme/Job/raw/.thumbnails/t.png', 1000);
    file('Acme/Job/raw/take.mp4', 20);

    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(job).toMatchObject({ inputs: { video: 2, audio: 0, image: 0, doc: 0 }, sizeBytes: 30 });
  });

  it('skips partial downloads, files and folders', async () => {
    file('Acme/Job/clip.mp4', 10);
    file('Acme/Job/next.mp4.crdownload', 900);
    file('Acme/Job/Unconfirmed 123.CRDOWNLOAD', 900);
    file('Acme/Job/audio.mp3.part', 900);
    file('Acme/Job/photo.jpg.download', 900);
    file('Acme/Job/Safari.mov.download/Info.plist', 900);
    file('Acme/Job/Safari.mov.download/data.mov', 900);

    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(job).toMatchObject({ inputs: { video: 1, audio: 0, image: 0, doc: 0 }, sizeBytes: 10 });
  });

  it('counts a macOS .pages package as one document and does not look inside it', async () => {
    file('Acme/Job/Brief.pages/Index/Document.iwa', 300);
    file('Acme/Job/Brief.pages/Data/photo-1.jpg', 200);
    file('Acme/Job/Brief.pages/Data/movie.mov', 400);
    file('Acme/Job/Brief.pages/QuickLook/Preview.pdf', 50);
    file('Acme/Job/Brief.pages/.hidden', 9999);
    file('Acme/Job/Old Brief.PAGES', 60);

    const { calls, durations } = fakeProbe();
    const [job] = await scanInbox(inbox, { durations });

    expect(job).toMatchObject({
      inputs: { video: 0, audio: 0, image: 0, doc: 2 },
      sizeBytes: 300 + 200 + 400 + 50 + 60,
      footageSec: 0,
    });
    expect(calls).toEqual([]);
  });

  it('treats other macOS packages as one unknown file, counted in size only', async () => {
    file('Acme/Job/Deck.key/Data/slide1.png', 100);
    file('Acme/Job/Deck.key/Data/intro.mov', 200);
    file('Acme/Job/Budget.numbers/Index.zip', 50);

    const { calls, durations } = fakeProbe();
    const [job] = await scanInbox(inbox, { durations });

    expect(job).toMatchObject({ inputs: { video: 0, audio: 0, image: 0, doc: 0 }, sizeBytes: 350 });
    expect(calls).toEqual([]);
  });
});

describe('scanInbox: footage length', () => {
  it('sums the probed length of video and audio only', async () => {
    file('Acme/Job/a.mp4', 10);
    file('Acme/Job/sub/b.MOV', 10);
    file('Acme/Job/voice.m4a', 10);
    file('Acme/Job/pic.jpg', 10);
    file('Acme/Job/brief.pdf', 10);
    file('Acme/Job/other.bin', 10);

    const { calls, durations } = fakeProbe({
      'a.mp4': 10.5,
      'b.MOV': 20.25,
      'voice.m4a': 4.125,
      // Would add to the total if images or documents were probed.
      'pic.jpg': 99,
      'brief.pdf': 99,
      'other.bin': 99,
    });
    const [job] = await scanInbox(inbox, { durations });

    expect(job?.footageSec).toBe(34.875);
    expect(calls.map((path) => basename(path)).sort()).toEqual(['a.mp4', 'b.MOV', 'voice.m4a']);
  });

  it('counts a file that cannot be read as 0 seconds, without failing the scan', async () => {
    file('Acme/Job/good.mp4', 10);
    file('Acme/Job/corrupt.mp4', 10);
    file('Acme/Job/boom.wav', 10);
    file('Acme/Job/half-copied.mov', 10);

    const { durations } = fakeProbe({
      'good.mp4': 8,
      'corrupt.mp4': null,
      'boom.wav': 'throw',
    });
    const [job] = await scanInbox(inbox, { durations });

    expect(job?.footageSec).toBe(8);
    // Unreadable files still count as inputs and in the size.
    expect(job?.inputs).toEqual({ video: 3, audio: 1, image: 0, doc: 0 });
    expect(job?.sizeBytes).toBe(40);
  });

  it('rounds away floating point noise', async () => {
    file('Acme/Job/a.mp4');
    file('Acme/Job/b.mp4');
    const { durations } = fakeProbe({ 'a.mp4': 0.1, 'b.mp4': 0.2 });
    const [job] = await scanInbox(inbox, { durations });
    expect(job?.footageSec).toBe(0.3);
  });

  it('probes a file once until its mtime or size changes', async () => {
    const clip = file('Acme/Job/clip.mp4', 10);
    const { calls, durations } = fakeProbe({ 'clip.mp4': 5 });

    await scanInbox(inbox, { durations });
    await scanInbox(inbox, { durations });
    const again = await scanJob(inbox, 'Acme', 'Job', { durations });
    expect(calls).toHaveLength(1);
    expect(again?.footageSec).toBe(5);

    setMtime(clip, Date.now() - 60_000);
    await scanInbox(inbox, { durations });
    expect(calls).toHaveLength(2);

    writeFileSync(clip, Buffer.alloc(25, 1));
    await scanInbox(inbox, { durations });
    expect(calls).toHaveLength(3);

    file('Acme/Job/second.mp4', 10);
    await scanInbox(inbox, { durations });
    expect(calls.map((path) => basename(path))).toEqual([
      'clip.mp4',
      'clip.mp4',
      'clip.mp4',
      'second.mp4',
    ]);
  });
});

describe('scanInbox: newest mtime', () => {
  it('is the newest modification time of the counted files', async () => {
    const t1 = Date.UTC(2026, 0, 5, 10, 0, 0);
    const t2 = Date.UTC(2026, 5, 20, 8, 30, 0);
    const t3 = Date.UTC(2027, 2, 1, 0, 0, 0);

    setMtime(file('Acme/Job/old.mp4'), t1);
    setMtime(file('Acme/Job/raw/newer.jpg'), t2);
    setMtime(file('Acme/Job/.DS_Store'), t3);
    setMtime(file('Acme/Job/edit/final.mp4'), t3);
    setMtime(file('Acme/Job/clip.mp4.crdownload'), t3);

    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(job?.newestMtimeMs).toBe(t2);
  });

  it('follows a package by the newest file inside it', async () => {
    // Later than the folders' own modification times, which are "now".
    const future = Date.UTC(2031, 3, 2, 12, 0, 0);
    setMtime(file('Acme/Job/Brief.pages/Index/Document.iwa'), future);

    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(job?.newestMtimeMs).toBe(future);
  });
});

describe('scanInbox: unreadable folders', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips a folder it cannot read and reports it',
    async () => {
      file('Acme/Job/clip.mp4', 10);
      const locked = dir('Acme/Job/locked');
      file('Acme/Job/locked/secret.mp4', 99);
      file('Beta/Other/clip.mp4', 5);
      chmodSync(locked, 0o000);

      try {
        const skipped: string[] = [];
        const jobs = await scanInbox(inbox, {
          durations: fakeProbe().durations,
          onSkip: (path) => skipped.push(path),
        });

        expect(jobs.map((job) => [job.relPath, job.sizeBytes])).toEqual([
          ['Acme/Job', 10],
          ['Beta/Other', 5],
        ]);
        expect(skipped).toEqual([locked]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe('scanJob', () => {
  it('returns the same record that scanInbox lists, and sees later changes', async () => {
    file('Acme/Job/clip.mp4', 10);
    file('Beta/Other/clip.mp4', 20);
    const { durations } = fakeProbe({ 'clip.mp4': 3 });

    const [listed] = await scanInbox(inbox, { durations });
    const single = await scanJob(inbox, 'Acme', 'Job', { durations });
    expect(single).toEqual(listed);

    file('Acme/Job/more/extra.wav', 5);
    const after = await scanJob(inbox, 'Acme', 'Job', { durations });
    expect(after?.inputs).toEqual({ video: 1, audio: 1, image: 0, doc: 0 });
    expect(after?.sizeBytes).toBe(15);
  });

  it('works for Hebrew names', async () => {
    file('לקוח/עבודה 1/clip.mp4', 10);
    const job = await scanJob(inbox, 'לקוח', 'עבודה 1', { durations: fakeProbe().durations });
    expect(job).toMatchObject({ relPath: 'לקוח/עבודה 1', id: sha1Id('לקוח/עבודה 1') });
  });

  it('returns null when the job is gone or is not a job', async () => {
    const { durations } = fakeProbe();
    file('Acme/Job/clip.mp4');
    file('Acme/loose.mp4');
    file('loose.mp4');
    dir('_Exports/Acme');
    dir('_Fonts/Job');
    dir('.hidden/Job');
    dir('Acme/.cache');
    dir('Acme/_Style/kit');
    dir('Finished/Acme');
    symlinkSync(join(inbox, 'Acme', 'Job'), join(inbox, 'Acme', 'Alias'));
    symlinkSync(join(inbox, 'Acme'), join(inbox, 'AliasClient'));

    const options = { durations, exportsDir: join(inbox, 'Finished') };
    const cases: [string, string][] = [
      ['Acme', 'Missing'],
      ['Missing', 'Job'],
      ['Acme', 'loose.mp4'],
      ['loose.mp4', 'anything'],
      ['_Exports', 'Acme'],
      ['_Fonts', 'Job'],
      ['.hidden', 'Job'],
      ['Acme', '.cache'],
      ['Acme', '_Style'],
      ['Acme', '_style'],
      ['Finished', 'Acme'],
      ['Acme', 'Alias'],
      ['AliasClient', 'Job'],
      ['', 'Job'],
      ['Acme', ''],
      ['..', 'Job'],
      ['Acme', '..'],
      ['.', 'Job'],
      ['Acme/Job', 'x'],
      ['Acme', 'Job/../Job'],
    ];
    for (const [client, name] of cases) {
      expect(await scanJob(inbox, client, name, options), `${client}/${name}`).toBeNull();
    }
    expect(await scanJob(inbox, 'Acme', 'Job', options)).not.toBeNull();
  });

  it('returns null once the folder is deleted', async () => {
    file('Acme/Job/clip.mp4');
    const options = { durations: fakeProbe().durations };
    expect(await scanJob(inbox, 'Acme', 'Job', options)).not.toBeNull();

    rmSync(join(inbox, 'Acme', 'Job'), { recursive: true });
    expect(await scanJob(inbox, 'Acme', 'Job', options)).toBeNull();
  });
});

describe('clientIdFor', () => {
  it('is the first 12 hex characters of sha1 of the NFC client name', () => {
    expect(clientIdFor('Acme')).toBe(sha1Id('Acme'));
    expect(clientIdFor('Acme')).toMatch(/^[0-9a-f]{12}$/);
    expect(clientIdFor('מאפיית הצפון')).toBe(sha1Id('מאפיית הצפון'));
  });

  it('gives the same id to NFC and NFD spellings of a name', () => {
    const nfc = 'Café Señal';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(clientIdFor(nfd)).toBe(clientIdFor(nfc));
    expect(clientIdFor(nfc)).toBe(sha1Id(nfc));
  });

  it('is case sensitive, like a job id: a renamed folder is a new client', () => {
    expect(clientIdFor('Acme')).not.toBe(clientIdFor('acme'));
    expect(clientIdFor('Acme')).not.toBe(clientIdFor('Acme '));
  });
});

describe('seriesIdFor', () => {
  it('is the first 12 hex characters of sha1 of <clientId>/<name>, in NFC', () => {
    const clientId = clientIdFor('עו״ד דוד לוי');
    expect(seriesIdFor(clientId, 'מיתוס או אמת')).toBe(sha1Id(`${clientId}/מיתוס או אמת`));
    // The shared fixtures use the real ids.
    expect(clientId).toBe('4b16f268bd46');
    expect(seriesIdFor(clientId, 'מיתוס או אמת')).toBe('622212180eef');
    const nfc = 'Café Weekly';
    expect(seriesIdFor(clientId, nfc.normalize('NFD'))).toBe(seriesIdFor(clientId, nfc));
  });

  it('gives two clients’ series of one name two ids', () => {
    expect(seriesIdFor(clientIdFor('Acme'), 'Weekly')).not.toBe(
      seriesIdFor(clientIdFor('Beta'), 'Weekly'),
    );
  });
});

describe('the _Series folder', () => {
  it('is never a job, whatever is inside it or how it is spelled', async () => {
    file('Acme/Spring/clip.mp4', 10);
    file('Acme/_Series/Weekly/series.md', 20);
    file('Acme/_Series/Weekly/kit/index.html', 40);
    file('Beta/_series/Weekly/kit/clip.mp4', 5);
    file('Gamma/_SERIES/reference.mp4', 9);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });

    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring']);
    expect(
      await scanJob(inbox, 'Acme', 'Spring', { durations: fakeProbe().durations }),
    ).toMatchObject({ inputs: { video: 1, audio: 0, image: 0, doc: 0 }, sizeBytes: 10 });
  });

  it('is not made by a scan: only the first series of a client makes it', async () => {
    file('Acme/Spring/clip.mp4', 10);
    await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(existsSync(join(inbox, 'Acme', '_Series'))).toBe(false);
  });
});

describe('the _Shared folder', () => {
  it('is never a job, whatever is inside it or how it is spelled, and is not made by a scan', async () => {
    file('Acme/Spring/clip.mp4', 10);
    file('Acme/_Shared/logo.png', 20);
    file('Acme/_Shared/broll/beach.mp4', 40);
    file('Beta/_shared/intro.mp4', 5);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });

    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring']);
    expect(
      await scanJob(inbox, 'Acme', 'Spring', { durations: fakeProbe().durations }),
    ).toMatchObject({ inputs: { video: 1, audio: 0, image: 0, doc: 0 }, sizeBytes: 10 });
    expect(existsSync(join(inbox, 'Gamma', '_Shared'))).toBe(false);
  });
});

describe('the _Style folder', () => {
  const isDir = (rel: string) =>
    existsSync(join(inbox, rel)) && statSync(join(inbox, rel)).isDirectory();

  it('is never a job, whatever is inside it or how it is spelled', async () => {
    file('Acme/Spring/clip.mp4', 10);
    file('Acme/_Style/style.md', 20);
    file('Acme/_Style/logo.png', 30);
    file('Acme/_Style/kit/slot_1/index.html', 40);
    file('Beta/_style/style.md', 5);
    file('Beta/Teaser/clip.mp4', 7);
    file('Gamma/_STYLE/reference.mp4', 9);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });

    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring', 'Beta/Teaser']);
    // Nor does it add to the job next to it.
    expect(jobs[0]).toMatchObject({
      inputs: { video: 1, audio: 0, image: 0, doc: 0 },
      sizeBytes: 10,
    });
  });

  it('is made in every client folder, jobs or not, and only once', async () => {
    file('Acme/Spring/clip.mp4', 10);
    dir('Beta');
    file('Gamma/Teaser/clip.mp4', 7);

    const options = { durations: fakeProbe().durations };
    await scanInbox(inbox, options);
    expect(isDir('Acme/_Style')).toBe(true);
    expect(isDir('Beta/_Style')).toBe(true);
    expect(isDir('Gamma/_Style')).toBe(true);
    expect(readdirSync(join(inbox, 'Acme')).sort()).toEqual(['Spring', '_Style']);

    // A second scan changes nothing, and leaves what is in the folder alone.
    file('Acme/_Style/style.md', 20);
    const before = statSync(join(inbox, 'Acme', '_Style')).ino;
    const jobs = await scanInbox(inbox, options);
    expect(statSync(join(inbox, 'Acme', '_Style')).ino).toBe(before);
    expect(readdirSync(join(inbox, 'Acme', '_Style'))).toEqual(['style.md']);
    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring', 'Gamma/Teaser']);
  });

  it('does not make a second folder where one exists under another case', async () => {
    dir('Acme/_style');
    file('Acme/Spring/clip.mp4', 10);
    // Only a case-insensitive volume (macOS by default) treats `_style` and `_Style` as one folder.
    if (!existsSync(join(inbox, 'Acme', '_STYLE'))) return;

    await scanInbox(inbox, { durations: fakeProbe().durations });

    const styleFolders = readdirSync(join(inbox, 'Acme')).filter(
      (name) => name.toLowerCase() === '_style',
    );
    expect(styleFolders).toHaveLength(1);
  });

  it('is not made in folders the inbox rules skip', async () => {
    file('Acme/Job/clip.mp4');
    dir('_Exports/Acme');
    dir('_Fonts/Rubik');
    dir('.hidden/Job');
    dir('.Trashes');
    dir('Finished/Acme');
    file('loose.txt');
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-scan-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(inbox, 'Linked Client'));

      await scanInbox(inbox, {
        exportsDir: join(inbox, 'Finished'),
        durations: fakeProbe().durations,
      });

      expect(isDir('Acme/_Style')).toBe(true);
      expect(readdirSync(inbox).sort()).toEqual([
        '.Trashes',
        '.hidden',
        'Acme',
        'Finished',
        'Linked Client',
        '_Exports',
        '_Fonts',
        'loose.txt',
      ]);
      for (const rel of ['_Exports', '_Fonts', '.hidden', '.Trashes', 'Finished']) {
        expect(
          readdirSync(join(inbox, rel)).filter((name) => name === '_Style'),
          rel,
        ).toEqual([]);
      }
      expect(readdirSync(join(inbox, 'Finished', 'Acme'))).toEqual([]);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('is left out of an inbox scanned with createStyleDirs: false', async () => {
    file('Acme/Spring/clip.mp4', 10);

    const jobs = await scanInbox(inbox, {
      createStyleDirs: false,
      durations: fakeProbe().durations,
    });

    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring']);
    expect(isDir('Acme/_Style')).toBe(false);
  });

  it('is not made when the inbox does not exist, and the inbox is not made either', async () => {
    const missing = join(inbox, 'nowhere');
    expect(await scanInbox(missing, { durations: fakeProbe().durations })).toEqual([]);
    expect(existsSync(missing)).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a client folder it cannot write to and still scans everything',
    async () => {
      file('Acme/Spring/clip.mp4', 10);
      file('Beta/Teaser/clip.mp4', 7);
      const locked = join(inbox, 'Acme');
      chmodSync(locked, 0o555);
      try {
        const skipped: string[] = [];
        const jobs = await scanInbox(inbox, {
          durations: fakeProbe().durations,
          onSkip: (path) => skipped.push(path),
        });
        expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring', 'Beta/Teaser']);
        expect(skipped).toEqual([join(locked, '_Style')]);
        expect(isDir('Beta/_Style')).toBe(true);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it('is not a job to scanJob either', async () => {
    file('Acme/Spring/clip.mp4', 10);
    await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(isDir('Acme/_Style')).toBe(true);
    expect(await scanJob(inbox, 'Acme', '_Style', { durations: fakeProbe().durations })).toBeNull();
  });
});

describe('ensureStyleDir', () => {
  const isDir = (rel: string) =>
    existsSync(join(inbox, rel)) && statSync(join(inbox, rel)).isDirectory();

  it('makes <client>/_Style, again and again without harm', async () => {
    dir('Acme');
    await ensureStyleDir(inbox, 'Acme');
    file('Acme/_Style/style.md', 3);
    await ensureStyleDir(inbox, 'Acme');
    await ensureStyleDir(inbox, 'Acme');

    expect(isDir('Acme/_Style')).toBe(true);
    expect(readdirSync(join(inbox, 'Acme', '_Style'))).toEqual(['style.md']);
  });

  it('does not make the client folder, so a folder that was just deleted stays deleted', async () => {
    await ensureStyleDir(inbox, 'Gone');
    expect(existsSync(join(inbox, 'Gone'))).toBe(false);
  });

  it('does nothing for what is not a client folder', async () => {
    file('loose.txt');
    dir('_Exports');
    dir('.hidden');
    dir('Finished');
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-scan-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(inbox, 'Linked'));
      for (const name of ['loose.txt', '_Exports', '_exports', '.hidden', 'Finished', 'Linked']) {
        await ensureStyleDir(inbox, name, { exportsDir: join(inbox, 'Finished') });
      }
      for (const name of ['', '.', '..', 'a/b', 'a\0b']) {
        await ensureStyleDir(inbox, name);
      }
      expect(readdirSync(inbox).sort()).toEqual([
        '.hidden',
        'Finished',
        'Linked',
        '_Exports',
        'loose.txt',
      ]);
      expect(readdirSync(elsewhere)).toEqual([]);
      expect(readdirSync(join(inbox, '_Exports'))).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a client folder it cannot write to',
    async () => {
      const locked = dir('Acme');
      chmodSync(locked, 0o555);
      try {
        const skipped: string[] = [];
        await ensureStyleDir(inbox, 'Acme', { onSkip: (path) => skipped.push(path) });
        expect(skipped).toEqual([join(locked, '_Style')]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe('listClientNames', () => {
  it('lists only the registered clients while a registry is in use', async () => {
    dir('Acme/Job');
    dir('edit/verify');
    useClientRegistry({ has: (name) => name === 'Acme' });
    try {
      expect(await listClientNames(inbox)).toEqual(['Acme']);
    } finally {
      useClientRegistry(null);
    }
  });

  it('lists the client folders, jobs or not, sorted, and makes nothing', async () => {
    file('Beta/Teaser/clip.mp4');
    dir('Acme');
    dir('Zed/Job');
    file('loose.txt');
    dir('_Exports/Acme');
    dir('_fonts/Rubik');
    dir('.hidden/Job');
    dir('Finished/Acme');
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-scan-elsewhere-'));
    try {
      symlinkSync(elsewhere, join(inbox, 'Linked'));
      expect(await listClientNames(inbox, { exportsDir: join(inbox, 'Finished') })).toEqual([
        'Acme',
        'Beta',
        'Zed',
      ]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    expect(existsSync(join(inbox, 'Acme', '_Style'))).toBe(false);
  });

  it('has none for an inbox that does not exist', async () => {
    expect(await listClientNames(join(inbox, 'nowhere'))).toEqual([]);
  });

  it('never lists the Graphics library _Graphics, in any case, nor its folders as jobs', async () => {
    dir('Acme/Spring');
    file('_Graphics/Name on a white pill/versions/v1/index.html');
    dir('_graphics/Title');

    expect(await listClientNames(inbox)).toEqual(['Acme']);
    expect(isClientFolderName(inbox, '_Graphics')).toBe(false);
    expect(isClientFolderName(inbox, '_GRAPHICS')).toBe(false);
    expect(isClientFolderName(inbox, 'Graphics')).toBe(true);
    expect(await isClientFolder(inbox, '_Graphics')).toBe(false);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring']);
    expect(
      await scanJob(inbox, '_Graphics', 'Name on a white pill', {
        durations: fakeProbe().durations,
      }),
    ).toBeNull();
    // Nothing of a client is made in it.
    expect(existsSync(join(inbox, '_Graphics', '_Style'))).toBe(false);
  });

  it('never lists the LUTs library _LUTs, in any case, nor anything in it as a job', async () => {
    dir('Acme/Spring');
    file('_LUTs/Golden Hour Warm.cube');
    dir('_luts/Sub');

    expect(await listClientNames(inbox)).toEqual(['Acme']);
    expect(isClientFolderName(inbox, '_LUTs')).toBe(false);
    expect(isClientFolderName(inbox, '_luts')).toBe(false);
    expect(isClientFolderName(inbox, 'LUTs')).toBe(true);
    expect(await isClientFolder(inbox, '_LUTs')).toBe(false);

    const jobs = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(jobs.map((job) => job.relPath)).toEqual(['Acme/Spring']);
    expect(await scanJob(inbox, '_LUTs', 'Sub', { durations: fakeProbe().durations })).toBeNull();
    // Nothing of a client is made in it.
    expect(existsSync(join(inbox, '_LUTs', '_Style'))).toBe(false);
  });
});

// The whole path with the real ffprobe, when it is installed.
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0,
);

describe.skipIf(!hasFfmpeg)('scanInbox with the real ffprobe', () => {
  it('measures generated clips and sums video and audio', async () => {
    const jobDir = dir('לקוח/סרטון 🎬/raw');
    const video = spawnSync(
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
        join(jobDir, 'clip.mp4'),
      ],
      { encoding: 'utf8' },
    );
    const audio = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        join(jobDir, 'tone.wav'),
      ],
      { encoding: 'utf8' },
    );
    expect(video.status, video.stderr).toBe(0);
    expect(audio.status, audio.stderr).toBe(0);
    file('לקוח/סרטון 🎬/not-really.mp4', 20);

    const [job] = await scanInbox(inbox, { durations: new DurationCache() });
    expect(job?.inputs).toEqual({ video: 2, audio: 1, image: 0, doc: 0 });
    // clip.mp4 is about 1 s, tone.wav is about 1 s, the fake mp4 is unreadable and counts 0.
    expect(job?.footageSec).toBeGreaterThan(1.8);
    expect(job?.footageSec).toBeLessThan(2.6);
  });
});

// B4: the Brief step's fingerprint and file list come from the same walk as the scan.
describe('listJobFiles', () => {
  it('lists the files the scan counts, sorted, with kind, size and mtime', async () => {
    const job = 'Acme/Teaser';
    setMtime(file(`${job}/clip.MOV`, 5), 1_700_000_000_000);
    file(`${job}/notes/brief.txt`, 3);
    file(`${job}/voice.opus`, 2);
    file(`${job}/project.fcpxml`, 4);
    file(`${job}/Brief.pages/Index.zip`, 6);
    file(`${job}/Brief.pages/QuickLook/Preview.pdf`, 7);
    file(`${job}/.DS_Store`);
    file(`${job}/.fail-at-brief`);
    file(`${job}/take.mp4.part`);
    file(`${job}/edit/brief.json`);
    file(`${job}/edit/transcripts/clip.json`);

    const files = await listJobFiles(join(inbox, job));

    expect(files.map((f) => [f.relPath, f.kind, f.size])).toEqual([
      ['Brief.pages', 'doc', 13],
      ['clip.MOV', 'video', 5],
      ['notes/brief.txt', 'doc', 3],
      ['project.fcpxml', 'other', 4],
      ['voice.opus', 'audio', 2],
    ]);
    expect(files[1]).toMatchObject({
      absPath: join(inbox, job, 'clip.MOV'),
      mtimeMs: 1_700_000_000_000,
    });
    // The same files the scan sizes up.
    const [scanned] = await scanInbox(inbox, { durations: fakeProbe().durations });
    expect(files.reduce((sum, f) => sum + f.size, 0)).toBe(scanned?.sizeBytes);
  });

  it('gives a folder that does not exist no files', async () => {
    expect(await listJobFiles(join(inbox, 'Nobody', 'Nothing'))).toEqual([]);
  });
});

// Generated videos (GN4): a folder with a script, a zip and a reference video, and no footage.
describe('scanInbox: a generated job (the Generate switch)', () => {
  const folder = 'Pinewood/97 Window Ad';

  /** The PINEWOOD shape: the client's brief, the references zip, and the reference video. */
  function pinewood(): void {
    file(`${folder}/PINEWOOD brief.txt`, 20);
    file(`${folder}/pinewood-references.zip`, 300);
    file(`${folder}/reference/reference-video-35s.mp4`, 4_000);
  }

  it('is a job with or without the switch: nothing here needs footage to arrive', async () => {
    pinewood();
    for (const generate of [false, true, undefined]) {
      const jobs = await scanInbox(inbox, { durations: fakeProbe().durations, generate });
      expect(jobs.map((job) => job.relPath)).toEqual([folder]);
    }
  });

  it('counts a reference video as footage while the switch is off, as before', async () => {
    pinewood();
    const [job] = await scanInbox(inbox, {
      durations: fakeProbe({ 'reference-video-35s.mp4': 35 }).durations,
    });
    expect(job?.inputs).toEqual({ video: 1, audio: 0, image: 0, doc: 1 });
    expect(job?.footageSec).toBe(35);
  });

  it('keeps a video under reference/ out of the inputs and the footage length with the switch on', async () => {
    pinewood();
    const { durations, calls } = fakeProbe({ 'reference-video-35s.mp4': 35 });
    const [job] = await scanInbox(inbox, { durations, generate: true });

    expect(job?.inputs).toEqual({ video: 0, audio: 0, image: 0, doc: 1 });
    expect(job?.footageSec).toBe(0);
    // Not probed at all, and its bytes still count toward the job's size.
    expect(calls).toEqual([]);
    expect(job?.sizeBytes).toBe(20 + 300 + 4_000);
  });

  it('keeps reference audio out too, and any depth under reference/, in any case', async () => {
    file(`${folder}/Reference/voice-sample.m4a`, 10);
    file(`${folder}/Reference/old/ad.MOV`, 10);
    file(`${folder}/Reference/old/frame.png`, 10);
    const [job] = await scanInbox(inbox, { durations: fakeProbe().durations, generate: true });
    // A picture in reference/ is still a picture: only video and audio are footage.
    expect(job?.inputs).toEqual({ video: 0, audio: 0, image: 1, doc: 0 });
  });

  it('only the reference/ folder at the root of the job, and only with the switch on', async () => {
    file(`${folder}/raw/clip.mp4`, 10);
    file(`${folder}/raw/reference/other.mp4`, 10);
    file(`${folder}/reference-video.mp4`, 10);
    file(`${folder}/reference/ignored.mp4`, 10);

    const on = await scanInbox(inbox, { durations: fakeProbe().durations, generate: true });
    expect(on[0]?.inputs.video).toBe(3);
    const off = await scanInbox(inbox, { durations: fakeProbe().durations, generate: false });
    expect(off[0]?.inputs.video).toBe(4);
  });

  it('scanJob takes the switch too', async () => {
    pinewood();
    const on = await scanJob(inbox, 'Pinewood', '97 Window Ad', {
      durations: fakeProbe().durations,
      generate: true,
    });
    expect(on?.inputs.video).toBe(0);
    const off = await scanJob(inbox, 'Pinewood', '97 Window Ad', {
      durations: fakeProbe().durations,
    });
    expect(off?.inputs.video).toBe(1);
  });

  it('listJobFiles still lists the reference video, with its kind, for the Brief', async () => {
    pinewood();
    const files = await listJobFiles(join(inbox, folder));
    expect(files.map((f) => [f.relPath, f.kind])).toEqual([
      ['PINEWOOD brief.txt', 'doc'],
      ['pinewood-references.zip', 'other'],
      ['reference/reference-video-35s.mp4', 'video'],
    ]);
  });
});
