import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Job, noInstructionsBrief } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedDirFor } from '../clients/paths.js';
import { BRIEF_MD_PATH, BriefStep, type BriefWriter } from './brief-step.js';
import { listSharedFiles } from './shared-files.js';

// A client's shared files in `<inbox>/<Client>/_Shared`, listed in brief.md before every edit run;
// the run copies the ones it uses into edit/shared/. Real temp folders throughout.

let inbox: string;
const RELPATH = 'Acme/Teaser';
const jobDir = () => join(inbox, RELPATH);
const copyDir = () => join(jobDir(), 'edit', 'shared');
const sharedDir = () => sharedDirFor(inbox, 'Acme');

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-shared-files-'));
  mkdirSync(jobDir(), { recursive: true });
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

/** Writes a file into the client's `_Shared`. */
function shared(relPath: string, content = relPath): string {
  const path = join(sharedDir(), relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('listSharedFiles', () => {
  it('lists every file anywhere in the folder, sorted, with / between folders', async () => {
    shared('logo.png');
    shared('broll/office.mov');
    shared('broll/beach.mp4');
    shared('notes.txt');

    expect(await listSharedFiles(sharedDir())).toEqual([
      'broll/beach.mp4',
      'broll/office.mov',
      'logo.png',
      'notes.txt',
    ]);
  });

  it('leaves out dot names, partial downloads and what is inside a macOS package', async () => {
    shared('logo.png');
    shared('.DS_Store');
    shared('.hidden/a.mp4');
    shared('broll/._beach.mp4');
    shared('clip.mp4.crdownload');
    shared('Deck.key/Data/thumb.jpg');

    expect(await listSharedFiles(sharedDir())).toEqual(['logo.png']);
  });

  it('counts a link to a file but never follows a link to a folder', async () => {
    const outside = join(inbox, 'outside');
    mkdirSync(join(outside, 'folder'), { recursive: true });
    writeFileSync(join(outside, 'intro.mp4'), 'intro');
    shared('logo.png');
    symlinkSync(join(outside, 'intro.mp4'), join(sharedDir(), 'intro.mp4'));
    symlinkSync(join(outside, 'folder'), join(sharedDir(), 'linked'));

    expect(await listSharedFiles(sharedDir())).toEqual(['intro.mp4', 'logo.png']);
  });

  it('has none when the folder is not there', async () => {
    expect(await listSharedFiles(sharedDir())).toEqual([]);
  });
});

describe('the Brief step with shared files', () => {
  const job: Job = {
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
    archivedAt: null,
    seriesId: null,
    episode: null,
    updatedAt: '2026-10-21T10:01:00.000Z',
    output: null,
    note: null,
  };
  const writer: BriefWriter = { write: async () => ({ ok: false, error: 'never runs' }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = () => ({ signal: new AbortController().signal, progress: vi.fn() });
  const brief = () => readFileSync(join(jobDir(), BRIEF_MD_PATH), 'utf8');

  beforeEach(() => {
    // Only footage and no note: the engine writes the brief itself, without a run.
    writeFileSync(join(jobDir(), 'clip.mp4'), 'x');
  });

  const listed =
    'The client keeps files for all of its videos in its _Shared folder, next to this job’s folder (../_Shared/ from the job folder), one line per folder in it:';

  it('lists the shared files in brief.md after the job’s files, on every prepare, and copies none', async () => {
    shared('logo.png');
    const step = new BriefStep({ inboxPath: inbox, writer, logger });

    expect(await step.prepare(job, ctx())).toMatchObject({ ok: true, source: 'skipped' });
    expect(brief()).toContain(
      `\n## Files\n- Footage: clip.mp4\n\n## Client shared files\n${listed}\n- At the top: logo.png\n`,
    );
    expect(existsSync(copyDir())).toBe(false);

    // A Retry: the brief is reused, but a file added since is listed.
    shared('broll/beach.mp4');
    expect(await step.prepare(job, ctx())).toMatchObject({ ok: true, source: 'reused' });
    expect(brief()).toContain('\n- At the top: logo.png\n- broll/: beach.mp4\n');
    // Shared files are not the job's inputs: the brief's own file list is as it was.
    expect(brief()).toContain('\n## Files\n- Footage: clip.mp4\n');
    expect(existsSync(copyDir())).toBe(false);
  });

  it('has no Client shared files section without a _Shared folder', async () => {
    const step = new BriefStep({ inboxPath: inbox, writer, logger });

    await step.prepare(job, ctx());
    expect(brief()).not.toContain('## Client shared files');
    expect(brief()).toContain(noInstructionsBrief(['clip.mp4']).summary);
  });

  it('leaves the copies a run made alone, even of a file no longer shared', async () => {
    const logo = shared('logo.png');
    mkdirSync(copyDir(), { recursive: true });
    writeFileSync(join(copyDir(), 'logo.png'), 'the run’s copy');
    rmSync(logo);
    const step = new BriefStep({ inboxPath: inbox, writer, logger });

    await step.prepare(job, ctx());
    expect(readFileSync(join(copyDir(), 'logo.png'), 'utf8')).toBe('the run’s copy');
    expect(brief()).not.toContain('## Client shared files');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never fails the brief over shared files: it warns and leaves them out',
    async () => {
      shared('logo.png');
      chmodSync(sharedDir(), 0o000);
      const step = new BriefStep({ inboxPath: inbox, writer, logger });

      try {
        expect(await step.prepare(job, ctx())).toMatchObject({ ok: true });
      } finally {
        chmodSync(sharedDir(), 0o755);
      }
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id }),
        'brief: the client’s shared files could not be read',
      );
      expect(brief()).not.toContain('## Client shared files');
    },
  );
});
