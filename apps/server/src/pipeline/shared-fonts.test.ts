import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Job, noInstructionsBrief } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_MD_PATH, BriefStep, type BriefWriter } from './brief-step.js';
import {
  copyFontsTo,
  copySharedFonts,
  FONTS_COPY_PATH,
  fontsDirFor,
  listFonts,
} from './shared-fonts.js';

// CVP-201: the shared fonts in `<inbox>/_Fonts`, copied into a job's edit/fonts/ before every
// edit run and listed at the end of brief.md. Real temp folders throughout.

let inbox: string;
const RELPATH = 'Acme/Teaser';
const jobDir = () => join(inbox, RELPATH);
const copyDir = () => join(jobDir(), FONTS_COPY_PATH);

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-shared-fonts-'));
  mkdirSync(jobDir(), { recursive: true });
});

afterEach(() => {
  rmSync(inbox, { recursive: true, force: true });
});

/** Writes a file into `<inbox>/_Fonts`. */
function font(relPath: string, content = relPath): string {
  const path = join(fontsDirFor(inbox), relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('listFonts', () => {
  it('lists the font files anywhere in the folder, sorted, with / between folders', async () => {
    font('Rubik/static/Rubik-Bold.ttf');
    font('Heebo-Bold.woff2');
    font('Assistant.OTF');
    font('Inter.woff');

    expect(await listFonts(fontsDirFor(inbox))).toEqual([
      'Assistant.OTF',
      'Heebo-Bold.woff2',
      'Inter.woff',
      'Rubik/static/Rubik-Bold.ttf',
    ]);
  });

  it('leaves out other files, dot names and partial downloads wherever they are', async () => {
    font('Heebo.ttf');
    font('OFL.txt');
    font('Heebo.zip');
    font('.DS_Store');
    font('._Heebo.ttf');
    font('.hidden/Inside.ttf');
    font('Rubik.ttf.crdownload');
    font('Assistant.ttf.download/Assistant.ttf');

    expect(await listFonts(fontsDirFor(inbox))).toEqual(['Heebo.ttf']);
  });

  it('has none for a folder that is not there, or a file in its place', async () => {
    expect(await listFonts(fontsDirFor(inbox))).toEqual([]);
    writeFileSync(fontsDirFor(inbox), 'not a folder');
    expect(await listFonts(fontsDirFor(inbox))).toEqual([]);
  });

  it('counts a link to a font file but does not follow a link to a folder', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-shared-fonts-elsewhere-'));
    try {
      writeFileSync(join(elsewhere, 'Linked.ttf'), 'linked');
      mkdirSync(fontsDirFor(inbox));
      symlinkSync(join(elsewhere, 'Linked.ttf'), join(fontsDirFor(inbox), 'Linked.ttf'));
      symlinkSync(elsewhere, join(fontsDirFor(inbox), 'Folder'));

      expect(await listFonts(fontsDirFor(inbox))).toEqual(['Linked.ttf']);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('copySharedFonts', () => {
  it('copies the fonts into edit/fonts/ at the same paths', async () => {
    font('Heebo-Bold.ttf', 'heebo');
    font('Rubik/Rubik-Bold.ttf', 'rubik');
    font('OFL.txt');

    expect(await copySharedFonts(inbox, jobDir())).toEqual([
      'Heebo-Bold.ttf',
      'Rubik/Rubik-Bold.ttf',
    ]);
    expect(readFileSync(join(copyDir(), 'Heebo-Bold.ttf'), 'utf8')).toBe('heebo');
    expect(readFileSync(join(copyDir(), 'Rubik/Rubik-Bold.ttf'), 'utf8')).toBe('rubik');
    expect(existsSync(join(copyDir(), 'OFL.txt'))).toBe(false);
    expect(readdirSync(join(jobDir(), 'edit'))).toEqual(['fonts']);
  });

  it('copies again each time: added fonts come in, removed ones go', async () => {
    font('Old.ttf');
    await copySharedFonts(inbox, jobDir());
    rmSync(join(fontsDirFor(inbox), 'Old.ttf'));
    font('New.ttf', 'new');

    expect(await copySharedFonts(inbox, jobDir())).toEqual(['New.ttf']);
    expect(readdirSync(copyDir())).toEqual(['New.ttf']);
  });

  it('copies the file a link points to, not the link', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-shared-fonts-elsewhere-'));
    try {
      writeFileSync(join(elsewhere, 'Linked.ttf'), 'linked');
      mkdirSync(fontsDirFor(inbox));
      symlinkSync(join(elsewhere, 'Linked.ttf'), join(fontsDirFor(inbox), 'Linked.ttf'));

      await copySharedFonts(inbox, jobDir());
      rmSync(elsewhere, { recursive: true, force: true });
      expect(readFileSync(join(copyDir(), 'Linked.ttf'), 'utf8')).toBe('linked');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('leaves no edit/fonts/ without fonts, and takes away one that was there', async () => {
    expect(await copySharedFonts(inbox, jobDir())).toEqual([]);
    expect(existsSync(join(jobDir(), 'edit'))).toBe(false);

    font('Heebo.ttf');
    await copySharedFonts(inbox, jobDir());
    rmSync(fontsDirFor(inbox), { recursive: true });
    expect(await copySharedFonts(inbox, jobDir())).toEqual([]);
    expect(readdirSync(join(jobDir(), 'edit'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the old copy and leaves nothing half made when a font cannot be read',
    async () => {
      font('Heebo.ttf', 'old');
      await copySharedFonts(inbox, jobDir());
      font('Heebo.ttf', 'new');
      chmodSync(font('Locked.ttf'), 0o000);

      await expect(copySharedFonts(inbox, jobDir())).rejects.toThrow();
      expect(readdirSync(copyDir())).toEqual(['Heebo.ttf']);
      expect(readFileSync(join(copyDir(), 'Heebo.ttf'), 'utf8')).toBe('old');
      expect(readdirSync(join(jobDir(), 'edit'))).toEqual(['fonts']);
    },
  );
});

describe('copyFontsTo (any folder: a graphic’s fonts/)', () => {
  const target = () => join(inbox, '_Graphics', 'Pill', 'fonts');

  it('copies the fonts into the folder it is given, at the same paths, and leaves nothing beside it', async () => {
    font('Heebo-Bold.ttf', 'heebo');
    font('Rubik/Rubik-Bold.ttf', 'rubik');
    font('OFL.txt');
    mkdirSync(join(inbox, '_Graphics', 'Pill'), { recursive: true });

    expect(await copyFontsTo(inbox, target())).toEqual(['Heebo-Bold.ttf', 'Rubik/Rubik-Bold.ttf']);

    expect(readFileSync(join(target(), 'Rubik/Rubik-Bold.ttf'), 'utf8')).toBe('rubik');
    expect(existsSync(join(target(), 'OFL.txt'))).toBe(false);
    expect(readdirSync(join(inbox, '_Graphics', 'Pill'))).toEqual(['fonts']);
  });

  it('copies fresh each time, and leaves no folder when there are no fonts', async () => {
    mkdirSync(join(inbox, '_Graphics', 'Pill'), { recursive: true });
    font('Old.ttf');
    await copyFontsTo(inbox, target());
    rmSync(join(fontsDirFor(inbox), 'Old.ttf'));
    font('New.ttf', 'new');

    expect(await copyFontsTo(inbox, target())).toEqual(['New.ttf']);
    expect(readdirSync(target())).toEqual(['New.ttf']);

    rmSync(join(fontsDirFor(inbox), 'New.ttf'));
    expect(await copyFontsTo(inbox, target())).toEqual([]);
    expect(existsSync(target())).toBe(false);
  });

  it('is what copySharedFonts does for a job, with the same staging name as before', async () => {
    font('Heebo.ttf');

    await copySharedFonts(inbox, jobDir());
    await copyFontsTo(inbox, join(jobDir(), 'edit', 'fonts'));

    expect(readdirSync(join(jobDir(), 'edit'))).toEqual(['fonts']);
    expect(readdirSync(copyDir())).toEqual(['Heebo.ttf']);
  });
});

describe('the Brief step with shared fonts', () => {
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

  it('copies the fonts and ends brief.md with them, on every prepare', async () => {
    font('Heebo-Bold.ttf');
    const step = new BriefStep({ inboxPath: inbox, writer, logger });

    expect(await step.prepare(job, ctx())).toMatchObject({ ok: true, source: 'skipped' });
    expect(readdirSync(copyDir())).toEqual(['Heebo-Bold.ttf']);
    expect(brief()).toContain(
      '\n## Fonts\nFonts every client can use are in edit/fonts/, one line per folder in it:\n- At the top: Heebo-Bold.ttf\n',
    );

    // A Retry: the brief is reused, but a font added since is copied and listed.
    font('Rubik.ttf');
    expect(await step.prepare(job, ctx())).toMatchObject({ ok: true, source: 'reused' });
    expect(readdirSync(copyDir()).sort()).toEqual(['Heebo-Bold.ttf', 'Rubik.ttf']);
    expect(brief()).toContain('\n- At the top: Heebo-Bold.ttf, Rubik.ttf\n');
  });

  it('has no Fonts section and no edit/fonts/ without shared fonts', async () => {
    const step = new BriefStep({ inboxPath: inbox, writer, logger });

    await step.prepare(job, ctx());
    expect(existsSync(copyDir())).toBe(false);
    expect(brief()).not.toContain('## Fonts');
    expect(brief()).toContain(noInstructionsBrief(['clip.mp4']).summary);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never fails the brief over fonts: it warns and lists the copy it had',
    async () => {
      font('Heebo.ttf');
      const step = new BriefStep({ inboxPath: inbox, writer, logger });
      await step.prepare(job, ctx());
      chmodSync(font('Locked.ttf'), 0o000);

      expect(await step.prepare(job, ctx())).toMatchObject({ ok: true });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id }),
        'brief: the shared fonts could not be copied',
      );
      expect(brief()).toContain('\n- At the top: Heebo.ttf\n');
    },
  );
});
