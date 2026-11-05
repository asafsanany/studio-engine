import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type BriefDraft, type Job, noInstructionsBrief } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIEF_JSON_PATH,
  type BriefContext,
  BriefStep,
  type BriefWrite,
  type BriefWriteOutcome,
  type BriefWriter,
} from './brief-step.js';

// The Brief step with pictures attached to the note (Songs, SG5): with the switch on they are
// listed to the Brief run, marked attached, and part of the fingerprint; with it off nothing is
// looked at. Real temp folders and a scripted writer, like brief-step.test.ts.

let inbox: string;
const RELPATH = 'Acme/Teaser';
const jobDir = () => join(inbox, RELPATH);
const FROM_YOU = 'edit/brief/from-you';

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-brief-attached-'));
  mkdirSync(jobDir(), { recursive: true });
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'b4b4b4b4b4b4',
    clientId: 'ed099798f237',
    client: 'Acme',
    name: 'Teaser',
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
    inputs: { video: 1, audio: 0, image: 0, doc: 0 },
    sizeBytes: 1,
    addedAt: '2026-10-21T10:00:00.000Z',
    lastChangeAt: '2026-10-21T10:00:00.000Z',
    settledAt: '2026-10-21T10:01:00.000Z',
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
    updatedAt: '2026-10-21T10:01:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

function put(relPath: string, content = 'x', mtime?: Date): string {
  const path = join(jobDir(), relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
  return path;
}

function draft(overrides: Partial<BriefDraft> = {}): BriefDraft {
  return {
    ...noInstructionsBrief(['clip.mp4']),
    summary: 'A 20-second reel.',
    files: [{ path: 'clip.mp4', role: 'footage', note: null }],
    ...overrides,
  };
}

class ScriptedWriter implements BriefWriter {
  readonly calls: BriefWrite[] = [];

  async write(_job: Job, run: BriefWrite): Promise<BriefWriteOutcome> {
    this.calls.push(run);
    const path = join(run.jobDir, BRIEF_JSON_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(draft()));
    return { ok: true };
  }
}

function context() {
  const controller = new AbortController();
  const progress = vi.fn<BriefContext['progress']>();
  return { progress, ctx: { signal: controller.signal, progress } };
}

function step(writer: BriefWriter, songs: boolean | undefined) {
  return new BriefStep({
    inboxPath: inbox,
    writer,
    pollIntervalMs: 10,
    ...(songs === undefined ? {} : { songs }),
  });
}

describe('pictures attached to the note, with Songs on', () => {
  it('gives the run the pictures with the job’s files, marked attached, sorted by path', async () => {
    put('clip.mp4');
    put(`${FROM_YOU}/IMG_4412.PNG`, 'png bytes');
    put(`${FROM_YOU}/צילום מסך.jpg`, 'jpg');
    const writer = new ScriptedWriter();
    const { ctx, progress } = context();

    const outcome = await step(writer, true).prepare(makeJob(), ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    const files = writer.calls[0]?.files ?? [];
    expect(files.map((file) => file.relPath)).toEqual([
      'clip.mp4',
      `${FROM_YOU}/IMG_4412.PNG`,
      `${FROM_YOU}/צילום מסך.jpg`,
    ]);
    expect(files.map((file) => file.attached)).toEqual([undefined, true, true]);
    expect(files[1]).toMatchObject({
      kind: 'image',
      size: 9,
      absPath: join(jobDir(), FROM_YOU, 'IMG_4412.PNG'),
    });
    // Two pictures are two more files to read.
    expect(progress).toHaveBeenCalledWith('reading 2 files');
  });

  it('runs the Brief for a job that has only footage and a picture (it is not "no instructions")', async () => {
    put('clip.mp4');
    put(`${FROM_YOU}/reel.png`);
    const writer = new ScriptedWriter();

    const outcome = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'ran' });
    expect(writer.calls).toHaveLength(1);
  });

  it('skips the run for footage alone, as it always did', async () => {
    put('clip.mp4');
    const writer = new ScriptedWriter();

    const outcome = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ ok: true, source: 'skipped' });
    expect(writer.calls).toHaveLength(0);
  });

  it('reuses the brief while the pictures are as they were', async () => {
    put('clip.mp4');
    put(`${FROM_YOU}/reel.png`, 'one', new Date('2026-10-20T10:00:00Z'));
    const writer = new ScriptedWriter();

    await step(writer, true).prepare(makeJob(), context().ctx);
    const again = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(again).toMatchObject({ ok: true, source: 'reused' });
    expect(writer.calls).toHaveLength(1);
  });

  it('runs the Brief again when a picture is added, replaced or removed', async () => {
    put('clip.mp4');
    put(`${FROM_YOU}/reel.png`, 'one', new Date('2026-10-20T10:00:00Z'));
    const writer = new ScriptedWriter();
    const brief = () => step(writer, true).prepare(makeJob(), context().ctx);

    const first = await brief();
    expect(first).toMatchObject({ source: 'ran' });
    const fingerprint = first.ok ? first.brief.fingerprint : '';

    // Added.
    put(`${FROM_YOU}/second.jpg`, 'two', new Date('2026-10-20T11:00:00Z'));
    const added = await brief();
    expect(added).toMatchObject({ source: 'ran' });
    expect(added.ok && added.brief.fingerprint).not.toBe(fingerprint);

    // Replaced (another size).
    put(`${FROM_YOU}/second.jpg`, 'two, longer', new Date('2026-10-20T11:00:00Z'));
    expect(await brief()).toMatchObject({ source: 'ran' });

    // Removed.
    rmSync(join(jobDir(), FROM_YOU, 'second.jpg'));
    const removed = await brief();
    expect(removed).toMatchObject({ source: 'ran' });
    expect(removed.ok && removed.brief.fingerprint).toBe(fingerprint);
    expect(writer.calls).toHaveLength(4);
  });

  it('does not list a half-written upload (a dot file) or a file that is no picture', async () => {
    put('clip.mp4');
    put(`${FROM_YOU}/.upload-1234.tmp`, 'partial');
    put(`${FROM_YOU}/notes.txt`, 'not a picture');
    const writer = new ScriptedWriter();

    const outcome = await step(writer, true).prepare(makeJob(), context().ctx);

    expect(outcome).toMatchObject({ source: 'skipped' });
  });
});

describe('pictures attached to the note, with Songs off', () => {
  it.each([false, undefined])('does not look at them (songs: %s)', async (songs) => {
    put('clip.mp4');
    put(`${FROM_YOU}/reel.png`);
    const writer = new ScriptedWriter();

    const outcome = await step(writer, songs).prepare(makeJob(), context().ctx);

    // Footage alone: the same brief as without the picture, and no run.
    expect(outcome).toMatchObject({ ok: true, source: 'skipped' });
    expect(writer.calls).toHaveLength(0);
  });

  it('gives the same fingerprint with or without a picture in the folder', async () => {
    put('clip.mp4');
    const without = await step(new ScriptedWriter(), false).prepare(makeJob(), context().ctx);
    put(`${FROM_YOU}/reel.png`);
    const withOne = await step(new ScriptedWriter(), false).prepare(makeJob(), context().ctx);

    expect(withOne).toMatchObject({ source: 'reused' });
    expect(withOne.ok && withOne.brief.fingerprint).toBe(without.ok && without.brief.fingerprint);
  });
});
