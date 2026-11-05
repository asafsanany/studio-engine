import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Job,
  type JobEvent,
  type ReviewNote,
  renderSeriesNotesFile,
  SERIES_MESSAGES,
} from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRepository, NoteRepository, SeriesRepository, type StoredSeries } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { createReviewService, type ReviewService } from '../review/review-service.js';
import { createSeriesNotes } from './series-notes.js';
import { type SeriesService, seriesOk, seriesRefusal } from './series-service.js';
import { fakeSeriesService } from './test-utils.js';

// Add to series (Series plan §6, K5) on the real repositories (in memory), a temp inbox and the
// fake series service, which stands in for K2's: it records what `addNotes` is asked and answers
// as the test decides. Send runs through the real review service. Since C26 the file only waits
// for the episode's approval; series-worker.test.ts follows it from Send to the approval.

const CLIENT = 'מאפיית הצפון';
const SERIES_NAME = 'שאלות נפוצות';
const JOB = 'פרומו לסוף השבוע';
const SENT_AT = '2026-10-21T10:00:00.000Z';

/** The file the notes are written to, as W16 names it. */
const NOTES_FILE = `Review notes – ${JOB} – round 1.md`;
const NOTES_FILE_TAKEN = `Review notes – ${JOB} – round 1 (1).md`;

const GOLDEN = fileURLToPath(
  new URL(
    '../../../../packages/shared/src/review/fixtures/bakery-series-notes.md',
    import.meta.url,
  ),
);

const REVIEW_PATH: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  inboxPath: string;
  jobs: JobRepository;
  notes: NoteRepository;
  seriesRepo: SeriesRepository;
  /** The series, stored and with its folder on disk. */
  series: StoredSeries;
  /** The job, an episode of `series` in review, at round 1 as Send leaves it. */
  job: Job;
  /** The fake series service's `addNotes` calls: the series id, the episode and the files. */
  added: { seriesId: string; jobId: string; files: { name: string; size: number }[] }[];
  warnings: { obj: object; msg: string }[];
  hook: ReturnType<typeof createSeriesNotes>;
  seriesDir: string;
  review: ReviewService;
  styleSeen: ReviewNote[][];
}

function setup(options: { addNotes?: SeriesService['addNotes']; enabled?: boolean } = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), 'studio-series-notes-'));
  dirs.push(root);
  const inboxPath = join(root, 'inbox');
  const clock = fakeClock();
  const db = memoryDb();
  const jobs = new JobRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const seriesRepo = new SeriesRepository(db, { clock });
  const scan = jobs.upsertFromScan(makeScan(CLIENT, JOB)).job;
  for (const event of REVIEW_PATH) jobs.applyTransition(scan.id, event);
  const series = seriesRepo.create({
    clientId: scan.clientId,
    client: CLIENT,
    name: SERIES_NAME,
    formatJobId: scan.id,
    formatJob: JOB,
    state: 'ready',
  });
  jobs.setSeries(scan.id, { seriesId: series.id, episode: 6, pinned: false });
  const job = { ...(jobs.get(scan.id) as Job), round: 1 };
  const seriesDir = join(inboxPath, CLIENT, '_Series', SERIES_NAME);
  mkdirSync(seriesDir, { recursive: true });
  mkdirSync(join(inboxPath, job.relPath), { recursive: true });

  const added: Setup['added'] = [];
  const fake = fakeSeriesService({
    addNotes:
      options.addNotes ??
      (async (seriesId, jobId, files) => {
        added.push({ seriesId, jobId, files: files.map((file) => ({ ...file })) });
        return seriesOk({ series: { id: seriesId } } as never);
      }),
  });
  const service: SeriesService = { ...fake.service, enabled: options.enabled ?? true };

  const warnings: Setup['warnings'] = [];
  const hook = createSeriesNotes({
    inboxPath,
    seriesRepo,
    series: service,
    logger: { info: () => {}, warn: (obj, msg) => warnings.push({ obj, msg }), error: () => {} },
  });

  // Send runs through the real review service, with a style hook that only records its notes.
  const styleSeen: ReviewNote[][] = [];
  let counter = 0;
  const review = createReviewService({
    db,
    jobs,
    notes,
    bus: createEventBus(),
    inboxPath,
    transcriber: { enqueue: () => new Promise(() => {}) },
    styleNotes: {
      append: async (_job, styled) => {
        styleSeen.push([...styled]);
      },
    },
    seriesNotes: hook,
    clock,
    newId: () => `n${++counter}`,
  });

  return {
    inboxPath,
    jobs,
    notes,
    seriesRepo,
    series,
    job,
    added,
    warnings,
    hook,
    seriesDir,
    review,
    styleSeen,
  };
}

const listDir = (dir: string) => readdirSync(dir).sort();

/** W16's bakery notes: a Hebrew text note, a voice note with its transcript, an English text note and a voice note that failed. */
function bakeryNotes(job: Job): ReviewNote[] {
  const note = (overrides: Partial<ReviewNote>): ReviewNote => ({
    id: `n${Math.random()}`,
    jobId: job.id,
    round: 1,
    atSec: 0,
    kind: 'text',
    text: 'A note.',
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: false,
    addToSeries: true,
    createdAt: SENT_AT,
    sentAt: SENT_AT,
    routeStatus: null,
    route: null,
    fixId: null,
    fixedAt: null,
    ...overrides,
  });
  return [
    note({ atSec: 21, text: 'End card: keep the logo up for two seconds.' }),
    note({
      atSec: 7.8,
      kind: 'voice',
      text: 'כאן הכתוביות מכסות את הידיים של יוסי. להעלות אותן קצת, או לבחור שוט אחר.',
      audioFile: 'edit/review/voice/n2.webm',
      audioSec: 6,
      transcriptStatus: 'done',
    }),
    note({ atSec: 2.43, text: 'הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.' }),
    note({
      atSec: 12,
      kind: 'voice',
      text: null,
      audioFile: 'edit/review/voice/n4.webm',
      audioSec: 5,
      transcriptStatus: 'failed',
    }),
  ];
}

describe('the series-notes file', () => {
  it('is written into the series folder with the series’ own wording', async () => {
    const s = setup();

    await s.hook.append(s.job, bakeryNotes(s.job));

    expect(listDir(s.seriesDir)).toEqual([NOTES_FILE]);
    const text = readFileSync(join(s.seriesDir, NOTES_FILE), 'utf8');
    expect(text).toBe(
      renderSeriesNotesFile({ series: SERIES_NAME, job: JOB, round: 1, notes: bakeryNotes(s.job) }),
    );
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'));
    expect(text).toContain('- 0:02.4 — הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.');
    expect(text).not.toContain('0:12.0');
  });

  it('says the notes are for the series, never for the client’s style', async () => {
    const s = setup();

    await s.hook.append(s.job, bakeryNotes(s.job));

    const text = readFileSync(join(s.seriesDir, NOTES_FILE), 'utf8');
    expect(text).toContain(`part of the series “${SERIES_NAME}”`);
    expect(text).toContain("rule for the series' next episodes");
    expect(text).not.toContain("client's style");
    expect(text).not.toContain('future videos');
  });

  it('goes only into the series folder: nothing in the client’s _Style or the job’s folder', async () => {
    const s = setup();

    await s.hook.append(s.job, bakeryNotes(s.job));

    expect(listDir(join(s.inboxPath, CLIENT))).toEqual(['_Series', s.job.name]);
    expect(listDir(join(s.inboxPath, s.job.relPath))).toEqual([]);
  });

  it('takes the next free name when its own is taken, and leaves the first file as it was', async () => {
    const s = setup();
    writeFileSync(join(s.seriesDir, NOTES_FILE), 'The owner’s own notes.\n');

    await s.hook.append(s.job, bakeryNotes(s.job));

    expect(listDir(s.seriesDir)).toEqual([NOTES_FILE_TAKEN, NOTES_FILE].sort());
    expect(readFileSync(join(s.seriesDir, NOTES_FILE), 'utf8')).toBe('The owner’s own notes.\n');
    expect(readFileSync(join(s.seriesDir, NOTES_FILE_TAKEN), 'utf8')).toBe(
      renderSeriesNotesFile({ series: SERIES_NAME, job: JOB, round: 1, notes: bakeryNotes(s.job) }),
    );
    expect(s.added).toEqual([
      {
        seriesId: s.series.id,
        jobId: s.job.id,
        files: [{ name: NOTES_FILE_TAKEN, size: expect.any(Number) }],
      },
    ]);
  });

  it('leaves series.md and the kit alone', async () => {
    const s = setup();
    writeFileSync(join(s.seriesDir, 'series.md'), '# Series\n');
    mkdirSync(join(s.seriesDir, 'kit'));

    await s.hook.append(s.job, bakeryNotes(s.job));

    expect(listDir(s.seriesDir)).toEqual([NOTES_FILE, 'kit', 'series.md'].sort());
    expect(readFileSync(join(s.seriesDir, 'series.md'), 'utf8')).toBe('# Series\n');
  });
});

describe('the file waiting for the episode’s approval (C26)', () => {
  it('is recorded once, for the episode, with exactly that file and its size', async () => {
    const s = setup();

    await s.hook.append(s.job, bakeryNotes(s.job));

    const size = Buffer.byteLength(readFileSync(join(s.seriesDir, NOTES_FILE), 'utf8'));
    expect(s.added).toEqual([
      { seriesId: s.series.id, jobId: s.job.id, files: [{ name: NOTES_FILE, size }] },
    ]);
    expect(s.warnings).toEqual([]);
  });

  it('is recorded after the file is in place', async () => {
    const s = setup({
      addNotes: async (_seriesId, _jobId, files) => {
        expect(listDir(s.seriesDir)).toContain(files[0]?.name);
        return seriesOk({ series: {} } as never);
      },
    });

    await s.hook.append(s.job, bakeryNotes(s.job));

    expect(s.warnings).toEqual([]);
  });

  it('is not recorded, and nothing is written, when no note has anything to turn into a rule', async () => {
    const s = setup();
    const failedVoiceOnly = bakeryNotes(s.job).filter((note) => note.atSec === 12);

    await s.hook.append(s.job, failedVoiceOnly);
    await s.hook.append(s.job, []);

    expect(listDir(s.seriesDir)).toEqual([]);
    expect(s.added).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  it('is not recorded while series are off, and nothing is written', async () => {
    const s = setup({ enabled: false });

    await s.hook.append(s.job, bakeryNotes(s.job));

    expect(listDir(s.seriesDir)).toEqual([]);
    expect(s.added).toEqual([]);
    expect(s.hook.enabled).toBe(false);
  });

  it('is not recorded for a job that is in no series, or whose series is gone', async () => {
    const s = setup();
    const noSeries = { ...s.job, seriesId: null, episode: null };
    const gone = { ...s.job, seriesId: 'ffffffffffff' };

    await expect(s.hook.append(noSeries, bakeryNotes(s.job))).resolves.toBeUndefined();
    await expect(s.hook.append(gone, bakeryNotes(s.job))).resolves.toBeUndefined();

    expect(listDir(s.seriesDir)).toEqual([]);
    expect(s.added).toEqual([]);
    expect(s.warnings).toHaveLength(2);
  });
});

describe('a series that can’t take the notes', () => {
  const logged = (s: Setup) =>
    s.warnings.filter((warning) => warning.msg === 'could not add the review notes to the series');

  it('is logged, not thrown: the service throws', async () => {
    const s = setup({
      addNotes: async () => {
        throw new Error('the worker is gone');
      },
    });

    await expect(s.hook.append(s.job, bakeryNotes(s.job))).resolves.toBeUndefined();

    expect(logged(s)).toHaveLength(1);
    expect(logged(s)[0]?.obj).toMatchObject({
      jobId: s.job.id,
      clientId: s.job.clientId,
      seriesId: s.series.id,
    });
  });

  it('is logged, not thrown: the service refuses', async () => {
    const s = setup({
      addNotes: async (seriesId) => seriesRefusal(404, `Series ${seriesId} not found`),
    });

    await expect(s.hook.append(s.job, bakeryNotes(s.job))).resolves.toBeUndefined();

    expect(logged(s)).toHaveLength(1);
    expect(logged(s)[0]?.obj).toMatchObject({
      status: 404,
      error: `Series ${s.series.id} not found`,
    });
  });

  it('is logged, not thrown: the series folder is a file', async () => {
    const s = setup();
    rmSync(s.seriesDir, { recursive: true });
    writeFileSync(s.seriesDir, 'not a folder');

    await expect(s.hook.append(s.job, bakeryNotes(s.job))).resolves.toBeUndefined();

    expect(s.warnings.map((warning) => warning.msg)).toEqual(['the series folder is missing']);
    expect(s.added).toEqual([]);
  });

  it('is logged, not thrown: the series folder is gone, and it is not made again', async () => {
    const s = setup();
    rmSync(join(s.inboxPath, CLIENT, '_Series'), { recursive: true });

    await expect(s.hook.append(s.job, bakeryNotes(s.job))).resolves.toBeUndefined();

    expect(s.warnings.map((warning) => warning.msg)).toEqual(['the series folder is missing']);
    expect(listDir(join(s.inboxPath, CLIENT))).toEqual([s.job.name]);
    expect(s.added).toEqual([]);
  });
});

describe('Send', () => {
  /** Notes on the episode, each marked as the test says; the review service's own rules apply. */
  function markedNotes(s: Setup, marks: { series?: boolean; style?: boolean }[]): string[] {
    return marks.map((mark, index) => {
      const note = s.review.addTextNote(s.job.id, { atSec: index + 1, text: `Note ${index + 1}` });
      if (mark.series) s.review.updateNote(s.job.id, note.id, { addToSeries: true });
      if (mark.style) s.review.updateNote(s.job.id, note.id, { addToStyle: true });
      return note.id;
    });
  }

  it('puts only the notes marked Series into the series file', async () => {
    const s = setup();
    markedNotes(s, [{ series: true }, {}, { series: true }, { style: true }]);

    const sent = await s.review.sendNotes(s.job.id);

    expect(sent).toMatchObject({ state: 'queued', round: 1 });
    expect(listDir(s.seriesDir)).toEqual([NOTES_FILE]);
    const text = readFileSync(join(s.seriesDir, NOTES_FILE), 'utf8');
    expect(text).toContain('- 0:01.0 — Note 1');
    expect(text).toContain('- 0:03.0 — Note 3');
    expect(text).not.toContain('Note 2');
    expect(text).not.toContain('Note 4');
    expect(s.added).toHaveLength(1);
    // The one note marked Style only goes to the style, not here.
    expect(s.styleSeen.map((styled) => styled.map((note) => note.text))).toEqual([['Note 4']]);
  });

  it('writes and records nothing when no note is marked Series', async () => {
    const s = setup();
    markedNotes(s, [{}, { style: true }]);

    await s.review.sendNotes(s.job.id);

    expect(listDir(s.seriesDir)).toEqual([]);
    expect(s.added).toEqual([]);
    expect(s.styleSeen.map((styled) => styled.length)).toEqual([1]);
  });

  it('puts a note marked both Series and Style into both', async () => {
    const s = setup();
    markedNotes(s, [{ series: true, style: true }, { series: true }, { style: true }]);

    await s.review.sendNotes(s.job.id);

    const text = readFileSync(join(s.seriesDir, NOTES_FILE), 'utf8');
    expect(text).toContain('Note 1');
    expect(text).toContain('Note 2');
    expect(text).not.toContain('Note 3');
    expect(s.styleSeen).toHaveLength(1);
    expect(s.styleSeen[0]?.map((note) => note.text)).toEqual(['Note 1', 'Note 3']);
    expect(s.added).toHaveLength(1);
  });

  it('is not failed by a series that can’t take the file: the job is sent and the failure is logged', async () => {
    const s = setup({
      addNotes: async () => {
        throw new Error('the worker is gone');
      },
    });
    markedNotes(s, [{ series: true }]);

    const sent = await s.review.sendNotes(s.job.id);

    expect(sent).toMatchObject({ state: 'queued', round: 1 });
    expect(s.warnings.map((warning) => warning.msg)).toEqual([
      'could not add the review notes to the series',
    ]);
  });

  it('is not failed by a series folder that is gone', async () => {
    const s = setup();
    rmSync(join(s.inboxPath, CLIENT, '_Series'), { recursive: true });
    markedNotes(s, [{ series: true }]);

    const sent = await s.review.sendNotes(s.job.id);

    expect(sent.state).toBe('queued');
    expect(s.added).toEqual([]);
  });
});

describe('marking a note Series', () => {
  it('is refused with 422 while series are off', () => {
    const s = setup({ enabled: false });
    const note = s.review.addTextNote(s.job.id, { atSec: 1, text: 'Note' });

    expect(() => s.review.updateNote(s.job.id, note.id, { addToSeries: true })).toThrow(
      SERIES_MESSAGES.off,
    );
    expect(s.notes.get(note.id)?.addToSeries).toBe(false);
  });

  it('is refused with 422 on a job that is in no series', () => {
    const s = setup();
    s.jobs.setSeries(s.job.id, { seriesId: null, episode: null, pinned: false });
    const note = s.review.addTextNote(s.job.id, { atSec: 1, text: 'Note' });

    expect(() => s.review.updateNote(s.job.id, note.id, { addToSeries: true })).toThrow(
      'Only a note on a job in a series can go into the series.',
    );
    expect(s.notes.get(note.id)?.addToSeries).toBe(false);
  });

  it('is allowed on an episode while series are on', () => {
    const s = setup();
    const note = s.review.addTextNote(s.job.id, { atSec: 1, text: 'Note' });

    expect(s.review.updateNote(s.job.id, note.id, { addToSeries: true }).addToSeries).toBe(true);
  });
});
