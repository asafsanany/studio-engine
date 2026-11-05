import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BriefDraft, briefSchema, type Job, noInstructionsBrief } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIEF_JSON_PATH,
  BRIEF_MD_PATH,
  type BriefContext,
  BriefStep,
  type BriefWrite,
  type BriefWriteOutcome,
  type BriefWriter,
  briefFingerprint,
} from './brief-step.js';
import { FakeBriefWriter } from './fake-brief.js';
import { buildZip, type ZipEntrySpec } from './zip/test-utils.js';

// The Brief step with the Generate switch (Generated videos, GN4): zips are unpacked before the
// run, a zip is never "only unknown files", the engine puts right the roles of the zips and the
// canvas of a generated brief, and a PINEWOOD-shaped folder goes through the fake writer. Real temp
// folders and a scripted writer, like brief-step.test.ts.

const TESTDATA = fileURLToPath(new URL('./testdata/pinewood/', import.meta.url));

/** The brief.json written by hand for the PINEWOOD folder (packages/shared/src/brief/fixtures/). */
const pinewood = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../packages/shared/src/brief/fixtures/pinewood-brief.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { draft: BriefDraft & { voiceover: { lines: { text: string }[] }; formats: string[] } };

let inbox: string;
const RELPATH = 'Pinewood/97 Window Ad';
const jobDir = () => join(inbox, RELPATH);
const UNZIPPED = 'edit/brief/unzipped/pinewood-references';

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-brief-generate-'));
  mkdirSync(jobDir(), { recursive: true });
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '97d97d97d97d',
    clientId: 'ed099798f237',
    client: 'Pinewood',
    name: '97 Window Ad',
    relPath: RELPATH,
    state: 'editing',
    step: 1,
    subProgress: null,
    etaSec: null,
    placeInLine: null,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 0, audio: 0, image: 0, doc: 1 },
    sizeBytes: 1,
    addedAt: '2026-10-25T10:00:00.000Z',
    lastChangeAt: '2026-10-25T10:00:00.000Z',
    settledAt: '2026-10-25T10:01:00.000Z',
    heldSettledAt: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    updatedAt: '2026-10-25T10:01:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

function put(relPath: string, content: string | Buffer = 'x'): string {
  const path = join(jobDir(), relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** The zip of the client's references: photos, a clip, and the junk a Mac adds. */
function referencesZip(extra: ZipEntrySpec[] = []): Buffer {
  const date = new Date(2026, 9, 25, 12, 52, 0);
  return buildZip([
    { name: 'WhatsApp Image 2026-10-15 at 15.12.21.jpeg', data: 'logo on black', date },
    { name: 'WhatsApp Image 2026-10-15 at 15.13.13.jpeg', data: 'the old $79 ad', date },
    { name: 'WhatsApp Video 2026-10-15 at 15.13.02.mp4', data: 'a dusty skylight', date },
    { name: '__MACOSX/._WhatsApp Image 2026-10-15 at 15.12.21.jpeg', data: 'junk', date },
    { name: '.DS_Store', data: 'junk', date },
    ...extra,
  ]);
}

/** A folder shaped like PINEWOOD: the brief text, the references zip, a reference video. */
function pinewoodFolder(): void {
  mkdirSync(jobDir(), { recursive: true });
  copyFileSync(join(TESTDATA, 'PINEWOOD brief.txt'), join(jobDir(), 'PINEWOOD brief.txt'));
  put('pinewood-references.zip', referencesZip());
  put('reference/reference-video-35s.mp4', 'a 35 second reference video');
}

function draft(overrides: Partial<BriefDraft> = {}): BriefDraft {
  return {
    ...noInstructionsBrief(['PINEWOOD brief.txt']),
    summary: 'A video to make from the client’s script.',
    files: [
      { path: 'PINEWOOD brief.txt', role: 'instructions', note: null },
      { path: 'reference/reference-video-35s.mp4', role: 'reference', note: null },
    ],
    ...overrides,
  };
}

class ScriptedWriter implements BriefWriter {
  readonly calls: BriefWrite[] = [];
  content: unknown = draft();

  async write(_job: Job, run: BriefWrite): Promise<BriefWriteOutcome> {
    this.calls.push(run);
    const path = join(run.jobDir, BRIEF_JSON_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.content));
    return { ok: true };
  }
}

function context() {
  const controller = new AbortController();
  const progress = vi.fn<BriefContext['progress']>();
  return { progress, ctx: { signal: controller.signal, progress } };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function step(writer: BriefWriter, generate: boolean | undefined, log = logger()) {
  return new BriefStep({
    inboxPath: inbox,
    writer,
    pollIntervalMs: 10,
    logger: log,
    ...(generate === undefined ? {} : { generate }),
  });
}

const brief = () =>
  briefSchema.parse(JSON.parse(readFileSync(join(jobDir(), BRIEF_JSON_PATH), 'utf8')));

describe('the Brief step with the Generate switch on: zips', () => {
  it('unpacks the zip before the run and gives the run the unpacked files, each from its zip', async () => {
    pinewoodFolder();
    const writer = new ScriptedWriter();

    const outcome = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    const files = writer.calls[0]?.files ?? [];
    expect(files.map((file) => file.relPath)).toEqual([
      'PINEWOOD brief.txt',
      `${UNZIPPED}/WhatsApp Image 2026-10-15 at 15.12.21.jpeg`,
      `${UNZIPPED}/WhatsApp Image 2026-10-15 at 15.13.13.jpeg`,
      `${UNZIPPED}/WhatsApp Video 2026-10-15 at 15.13.02.mp4`,
      'pinewood-references.zip',
      'reference/reference-video-35s.mp4',
    ]);
    expect(files.map((file) => file.fromZip)).toEqual([
      undefined,
      'pinewood-references.zip',
      'pinewood-references.zip',
      'pinewood-references.zip',
      undefined,
      undefined,
    ]);
    expect(files.map((file) => file.kind)).toEqual([
      'doc',
      'image',
      'image',
      'video',
      'other',
      'video',
    ]);
    // Junk stayed in the zip, and the unpacked files are really on disk, with their content.
    expect(readdirSync(join(jobDir(), UNZIPPED)).sort()).toEqual([
      '.unzipped.json',
      'WhatsApp Image 2026-10-15 at 15.12.21.jpeg',
      'WhatsApp Image 2026-10-15 at 15.13.13.jpeg',
      'WhatsApp Video 2026-10-15 at 15.13.02.mp4',
    ]);
    expect(readFileSync(files[1]?.absPath ?? '', 'utf8')).toBe('logo on black');
  });

  it('writes only under edit/: the job folder keeps exactly its own files', async () => {
    pinewoodFolder();
    await step(new ScriptedWriter(), true).prepare(makeJob(), context().ctx);
    expect(readdirSync(jobDir()).sort()).toEqual([
      'PINEWOOD brief.txt',
      'edit',
      'pinewood-references.zip',
      'reference',
    ]);
    expect(readdirSync(join(jobDir(), 'reference'))).toEqual(['reference-video-35s.mp4']);
  });

  it('counts the unpacked files in the "reading n files" line, not the videos', async () => {
    pinewoodFolder();
    const { ctx, progress } = context();
    await step(new ScriptedWriter(), true).prepare(makeJob(), ctx);
    // the brief text, two photos and the zip: the two videos are left out, as for any job.
    expect(progress).toHaveBeenCalledWith('reading 4 files');
  });

  it('gives the zip the role ignore even when the run called it a reference, and adds it when the run left it out', async () => {
    pinewoodFolder();
    const writer = new ScriptedWriter();
    writer.content = draft({
      files: [
        { path: 'PINEWOOD brief.txt', role: 'instructions', note: null },
        { path: 'pinewood-references.zip', role: 'reference', note: 'the client’s photos' },
      ],
    });
    await step(writer, true).prepare(makeJob(), context().ctx);
    expect(brief().files.find((file) => file.path === 'pinewood-references.zip')).toEqual({
      path: 'pinewood-references.zip',
      role: 'ignore',
      note: 'the client’s photos',
    });

    rmSync(join(jobDir(), BRIEF_JSON_PATH));
    writer.content = draft({
      files: [{ path: 'PINEWOOD brief.txt', role: 'instructions', note: null }],
    });
    // Another fingerprint, so the run happens again.
    put('PINEWOOD brief.txt', 'changed');
    await step(writer, true).prepare(makeJob(), context().ctx);
    expect(brief().files.find((file) => file.path === 'pinewood-references.zip')?.role).toBe(
      'ignore',
    );
  });

  it('takes the first of formats as the canvas when the run left the canvas null', async () => {
    pinewoodFolder();
    const writer = new ScriptedWriter();
    writer.content = draft({
      canvas: null,
      formats: ['1080x1920', '1080x1080'],
      production: 'generate',
    });
    await step(writer, true).prepare(makeJob(), context().ctx);
    expect(brief()).toMatchObject({ canvas: '1080x1920', formats: ['1080x1920', '1080x1080'] });

    // A canvas the run did set stays.
    put('PINEWOOD brief.txt', 'changed');
    writer.content = draft({ canvas: '1080x1350', formats: ['1080x1920', '1080x1080'] });
    await step(writer, true).prepare(makeJob(), context().ctx);
    expect(brief().canvas).toBe('1080x1350');
  });

  it('keeps production, voiceover, formats and budget exactly as the run wrote them', async () => {
    pinewoodFolder();
    const writer = new ScriptedWriter();
    writer.content = pinewood.draft;
    await step(writer, true).prepare(makeJob(), context().ctx);
    const written = brief();
    expect(written.production).toBe('generate');
    expect(written.voiceover?.lines).toHaveLength(7);
    expect(written.formats).toEqual(['1080x1920', '1080x1080']);
    expect(written.budgetUsd).toBeNull();
    expect(readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8')).toContain('## Generated video');
  });
});

describe('the Brief step with the Generate switch on: the fingerprint', () => {
  it('reuses the brief when nothing changed, and does not run the writer or unpack again', async () => {
    pinewoodFolder();
    const writer = new ScriptedWriter();
    const first = await step(writer, true).prepare(makeJob(), context().ctx);
    expect(first).toMatchObject({ source: 'ran' });
    const marker = statSync(join(jobDir(), UNZIPPED, '.unzipped.json')).mtimeMs;

    const second = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(second).toMatchObject({ ok: true, source: 'reused' });
    expect(writer.calls).toHaveLength(1);
    expect(statSync(join(jobDir(), UNZIPPED, '.unzipped.json')).mtimeMs).toBe(marker);
  });

  it('runs the writer again when the zip’s content changed, even to the same size and date', async () => {
    pinewoodFolder();
    const date = new Date(2026, 9, 25, 12, 52, 0);
    const zip = (text: string) => buildZip([{ name: 'a.txt', data: text, date, method: 'store' }]);
    put('pinewood-references.zip', zip('aaaa'));
    const writer = new ScriptedWriter();
    await step(writer, true).prepare(makeJob(), context().ctx);
    const zipPath = join(jobDir(), 'pinewood-references.zip');
    const stamp = statSync(zipPath);

    // Other bytes in the zip; its size and its modified time are put back to what they were.
    writeFileSync(zipPath, zip('bbbb'));
    utimesSync(zipPath, stamp.atime, stamp.mtime);
    expect(statSync(zipPath).size).toBe(stamp.size);

    const again = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(again).toMatchObject({ source: 'ran' });
    expect(writer.calls).toHaveLength(2);
    expect(readFileSync(join(jobDir(), UNZIPPED, 'a.txt'), 'utf8')).toBe('bbbb');
  });

  it('is told by the zip’s content: a file’s CRC replaces its modified time in the line', () => {
    const same = { relPath: 'edit/brief/unzipped/z/a.txt', size: 4, mtimeMs: 1_000 };
    const one = briefFingerprint([{ ...same, contentKey: 'aaaaaaaa' }], null);
    expect(briefFingerprint([{ ...same, contentKey: 'bbbbbbbb' }], null)).not.toBe(one);
    // The modified time no longer matters for such a file: unpacking again must not change it.
    expect(briefFingerprint([{ ...same, mtimeMs: 9_999, contentKey: 'aaaaaaaa' }], null)).toBe(one);
    // A file without a contentKey is fingerprinted exactly as before.
    expect(briefFingerprint([same], null)).not.toBe(one);
    expect(briefFingerprint([same], null)).toBe(briefFingerprint([{ ...same }], null));
  });

  it('gives another fingerprint when the zip is added or removed', async () => {
    put('PINEWOOD brief.txt', 'script');
    const writer = new ScriptedWriter();
    await step(writer, true).prepare(makeJob(), context().ctx);
    const without = brief().fingerprint;

    put('pinewood-references.zip', referencesZip());
    await step(writer, true).prepare(makeJob(), context().ctx);
    const withZip = brief().fingerprint;
    expect(withZip).not.toBe(without);
    expect(writer.calls).toHaveLength(2);

    rmSync(join(jobDir(), 'pinewood-references.zip'));
    await step(writer, true).prepare(makeJob(), context().ctx);
    expect(brief().fingerprint).toBe(without);
    // The unpacked folder of the zip that is gone is gone too.
    expect(existsSync(join(jobDir(), UNZIPPED))).toBe(false);
  });
});

// 31 Oct: a winery brief named six clips that were all in the client's _Shared. The Brief run saw
// only the job folder and called the video generated; Generate then stopped for want of a script.
describe('the Brief step with the Generate switch on: the client’s shared files', () => {
  const sharedDir = () => join(inbox, 'Pinewood', '_Shared');
  function share(relPath: string): void {
    const path = join(sharedDir(), relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'a clip');
  }

  it('names them to the run of a folder with no footage', async () => {
    put('PINEWOOD brief.txt', 'Clips C7909 and C7953, cut on the beat.');
    share('C7909.MP4');
    share('broll/C7953.MP4');
    const writer = new ScriptedWriter();

    await step(writer, true).prepare(makeJob(), context().ctx);

    expect(writer.calls[0]?.shared).toEqual(['C7909.MP4', 'broll/C7953.MP4']);
  });

  it('names none to a folder with footage of its own, or with the switch off', async () => {
    put('PINEWOOD brief.txt', 'Cut it short.');
    share('C7909.MP4');
    const off = new ScriptedWriter();
    await step(off, false).prepare(makeJob(), context().ctx);
    expect(off.calls[0]?.shared).toBeUndefined();

    put('clip.mp4', 'footage');
    const on = new ScriptedWriter();
    await step(on, true).prepare(makeJob(), context().ctx);
    expect(on.calls[0]?.shared).toBeUndefined();
  });

  it('writes the brief again when a clip lands in _Shared after it, for a folder with no footage', async () => {
    put('PINEWOOD brief.txt', 'Clips C7909 and C7953.');
    share('C7909.MP4');
    const writer = new ScriptedWriter();
    await step(writer, true).prepare(makeJob(), context().ctx);
    expect(await step(writer, true).prepare(makeJob(), context().ctx)).toMatchObject({
      source: 'reused',
    });

    share('C7953.MP4');
    const again = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(again).toMatchObject({ source: 'ran' });
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[1]?.shared).toEqual(['C7909.MP4', 'C7953.MP4']);
  });

  it('keeps the brief of a folder with footage when _Shared changes', async () => {
    put('PINEWOOD brief.txt', 'Cut it short.');
    put('clip.mp4', 'footage');
    const writer = new ScriptedWriter();
    await step(writer, true).prepare(makeJob(), context().ctx);

    share('C7909.MP4');
    const again = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(again).toMatchObject({ source: 'reused' });
    expect(writer.calls).toHaveLength(1);
  });

  it('fingerprints a folder exactly as before when no shared files are named', () => {
    const files = [{ relPath: 'brief.docx', size: 4, mtimeMs: 1_000 }];
    expect(briefFingerprint(files, null, [])).toBe(briefFingerprint(files, null));
    expect(briefFingerprint(files, null, ['C7909.MP4'])).not.toBe(briefFingerprint(files, null));
  });
});

describe('the Brief step with the Generate switch on: no skip for a zip', () => {
  it('runs the writer for a zip and a reference video with no note, where footage alone is skipped', async () => {
    put('pinewood-references.zip', referencesZip());
    put('reference/reference-video-35s.mp4', 'v');
    const writer = new ScriptedWriter();

    const outcome = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    expect(writer.calls).toHaveLength(1);
  });

  it('runs the writer for a video under reference/ alone: it is style to match, not footage to skip', async () => {
    put('reference/reference-video-35s.mp4', 'v');
    const writer = new ScriptedWriter();
    expect(await step(writer, true).prepare(makeJob(), context().ctx)).toMatchObject({
      ok: true,
      source: 'ran',
    });
    expect(writer.calls).toHaveLength(1);

    // Off, it is footage like any other video: skipped, as it always was.
    rmSync(join(jobDir(), 'edit'), { recursive: true, force: true });
    expect(await step(writer, false).prepare(makeJob(), context().ctx)).toMatchObject({
      ok: true,
      source: 'skipped',
    });
    expect(writer.calls).toHaveLength(1);
  });

  it('still skips a folder of only video and unknown files, with the switch on', async () => {
    put('clip.mp4', 'v');
    put('project.fcpxml', 'x');
    const writer = new ScriptedWriter();
    const outcome = await step(writer, true).prepare(makeJob(), context().ctx);
    expect(outcome).toMatchObject({ ok: true, source: 'skipped' });
    expect(writer.calls).toHaveLength(0);
  });
});

describe('the Brief step with the Generate switch on: a zip that is refused', () => {
  it('stops the brief with a plain line about the zip, and never runs the writer', async () => {
    put('PINEWOOD brief.txt', 'script');
    put('pinewood-references.zip', buildZip([{ name: '../../evil.txt', data: 'gotcha' }]));
    const writer = new ScriptedWriter();
    const log = logger();

    const outcome = await step(writer, true, log).prepare(makeJob(), context().ctx);

    expect(outcome).toEqual({
      ok: false,
      error:
        'Brief stopped: the zip “pinewood-references.zip” has a file that would land outside its folder (“../../evil.txt”).',
    });
    expect(writer.calls).toHaveLength(0);
    // A refused zip is a failure to report (the usual warning), not a bug in the engine.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: '97d97d97d97d' }),
      'brief failed',
    );
    expect(log.error).not.toHaveBeenCalled();
    expect(existsSync(join(inbox, 'evil.txt'))).toBe(false);
    expect(existsSync(join(jobDir(), BRIEF_JSON_PATH))).toBe(false);
  });

  it('says so for too many files and for a zip that is not a zip', async () => {
    put('PINEWOOD brief.txt', 'script');
    const many = Array.from(
      { length: 501 },
      (_, i): ZipEntrySpec => ({ name: `f${i}.txt`, data: 'x' }),
    );
    put('refs.zip', buildZip(many));
    const tooMany = await step(new ScriptedWriter(), true).prepare(makeJob(), context().ctx);
    expect(tooMany).toEqual({
      ok: false,
      error: 'Brief stopped: the zip “refs.zip” has more than 500 files (500 is the most).',
    });

    put('refs.zip', 'not a zip at all, only words');
    const notZip = await step(new ScriptedWriter(), true).prepare(makeJob(), context().ctx);
    expect(notZip).toEqual({
      ok: false,
      error: 'Brief stopped: the zip “refs.zip” is damaged or isn’t a zip.',
    });
  });
});

describe('the Brief step with the Generate switch off: nothing changes', () => {
  it('does not unpack the zip, lists it as an unknown file and writes nothing under edit/brief/', async () => {
    pinewoodFolder();
    const writer = new ScriptedWriter();

    const outcome = await step(writer, undefined).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    const files = writer.calls[0]?.files ?? [];
    expect(files.map((file) => file.relPath)).toEqual([
      'PINEWOOD brief.txt',
      'pinewood-references.zip',
      'reference/reference-video-35s.mp4',
    ]);
    expect(files.every((file) => file.fromZip === undefined && file.contentKey === undefined)).toBe(
      true,
    );
    expect(existsSync(join(jobDir(), 'edit/brief/unzipped'))).toBe(false);
  });

  it('skips a folder of a zip and video with no note, as before', async () => {
    put('pinewood-references.zip', referencesZip());
    put('reference/reference-video-35s.mp4', 'v');
    const writer = new ScriptedWriter();
    for (const generate of [undefined, false]) {
      rmSync(join(jobDir(), 'edit'), { recursive: true, force: true });
      const outcome = await step(writer, generate).prepare(makeJob(), context().ctx);
      expect(outcome).toMatchObject({ ok: true, source: 'skipped' });
    }
    expect(writer.calls).toHaveLength(0);
  });

  it('does not even open a zip that is refused with the switch on', async () => {
    put('PINEWOOD brief.txt', 'script');
    put('pinewood-references.zip', buildZip([{ name: '../evil.txt', data: 'x' }]));
    const outcome = await step(new ScriptedWriter(), false).prepare(makeJob(), context().ctx);
    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
  });

  it('drops production, voiceover and budgetUsd a run wrote anyway and keeps formats, and says so', async () => {
    put('PINEWOOD brief.txt', 'script');
    const writer = new ScriptedWriter();
    writer.content = pinewood.draft;
    const log = logger();

    await step(writer, undefined, log).prepare(makeJob(), context().ctx);

    expect(brief()).toMatchObject({
      production: null,
      voiceover: null,
      // Formats are asked for by any job, not only a generated one (Formats, GN7).
      formats: ['1080x1920', '1080x1080'],
      budgetUsd: null,
      // Everything else of the draft is as the run wrote it.
      canvas: '1080x1920',
      summary: pinewood.draft.summary,
    });
    expect(readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8')).not.toContain('## Generated video');
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(Object),
      'brief: the Generate switch is off, so production, voiceover and budgetUsd are dropped',
    );
  });

  it('leaves a draft without the keys alone, with nothing logged', async () => {
    put('PINEWOOD brief.txt', 'script');
    const log = logger();
    await step(new ScriptedWriter(), false, log).prepare(makeJob(), context().ctx);
    expect(brief().production).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('a PINEWOOD-shaped folder through the fake Brief run', () => {
  const fake = (generate: boolean) =>
    new FakeBriefWriter({ speed: 1, sleep: async () => {}, generate });

  it('with the switch on becomes a generated brief: production, the script word for word, both formats', async () => {
    pinewoodFolder();

    const outcome = await step(fake(true), true).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    const written = brief();
    expect(written.production).toBe('generate');
    // The same seven lines the hand-written brief.json of the folder has, from the same client text.
    expect(written.voiceover?.lines.map((line) => line.text)).toEqual(
      pinewood.draft.voiceover.lines.map((line) => line.text),
    );
    expect(written.voiceover?.lines.map((line) => line.id)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
      'L7',
    ]);
    expect(written.formats).toEqual(pinewood.draft.formats);
    expect(written.canvas).toBe('1080x1920');
    expect(written.budgetUsd).toBeNull();

    const role = (path: string) => written.files.find((file) => file.path === path)?.role;
    expect(role('pinewood-references.zip')).toBe('ignore');
    expect(role('reference/reference-video-35s.mp4')).toBe('reference');
    expect(role(`${UNZIPPED}/WhatsApp Video 2026-10-15 at 15.13.02.mp4`)).toBe('reference');
    expect(role(`${UNZIPPED}/WhatsApp Image 2026-10-15 at 15.12.21.jpeg`)).toBe('reference');
    expect(role('PINEWOOD brief.txt')).toBe('instructions');
    expect(written.files.filter((file) => file.role === 'footage')).toEqual([]);

    const markdown = readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8');
    expect(markdown).toContain('Production: generate. There is no footage');
    expect(markdown).toContain('L2: "But what about the view you look at every day?"');
    expect(markdown).toContain('Formats: 1080x1920, 1080x1080, one video of each');
  });

  it('with the switch off is the stand-in brief it always was: no production, no script', async () => {
    pinewoodFolder();
    const outcome = await step(fake(false), undefined).prepare(makeJob(), context().ctx);
    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    expect(brief()).toMatchObject({
      production: null,
      voiceover: null,
      formats: null,
      canvas: null,
    });
    expect(
      brief().files.find((file) => file.path === 'reference/reference-video-35s.mp4')?.role,
    ).toBe('footage');
  });

  it('is not a generated job when the folder has footage next to the script', async () => {
    pinewoodFolder();
    put('raw/interview.mp4', 'footage');
    await step(fake(true), true).prepare(makeJob(), context().ctx);
    expect(brief()).toMatchObject({ production: null, voiceover: null });
    expect(brief().files.find((file) => file.path === 'raw/interview.mp4')?.role).toBe('footage');
  });

  it('is not a generated job without a script in the text: only instructions', async () => {
    put('notes.txt', 'Cut it short. Keep the logo. Deliver 1080 × 1920.');
    put('reference/ref.mp4', 'v');
    await step(fake(true), true).prepare(makeJob(), context().ctx);
    expect(brief()).toMatchObject({ production: null, voiceover: null, formats: null });
  });
});
