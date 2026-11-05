import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  InvalidTransition,
  type Job,
  type JobEvent,
  type ReviewNote,
  SERIES_MESSAGES,
  type ServerEvent,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobNotFoundError, JobRepository, NoteRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import {
  TRANSCRIPTION_ERROR_CODES,
  TranscriptionError,
  type VoiceJob,
  type VoiceTranscript,
} from '../pipeline/voice-transcriber.js';
import type { NoteRouting } from './note-routing.js';
import {
  createReviewService,
  type NoteFixRules,
  noteNotFoundMessage,
  REVIEW_MESSAGES,
  ReviewError,
  type ReviewService,
  type SeriesNotesHook,
  type StyleNotesHook,
} from './review-service.js';

// The real repositories on an in-memory database, a real temp inbox, a bus that records every
// event, and a transcriber stand-in whose results the test decides.

const CLIENT = 'Northwind Bakery';
const OUTPUT = {
  fileName: `${CLIENT}/Ready one.mp4`,
  durationSec: 45.2,
  width: 1080,
  height: 1920,
  sizeBytes: 1000,
};

const SETTLED_AND_STARTED: JobEvent[] = [{ type: 'SETTLED' }, { type: 'START' }];

/** Every state, with the events that reach it from a new (arriving) job. An array, not a Record. */
const STATE_PATHS: Array<[Job['state'], JobEvent[]]> = [
  ['arriving', []],
  ['queued', [{ type: 'SETTLED' }]],
  ['held', [{ type: 'HOLD' }]],
  ['editing', SETTLED_AND_STARTED],
  ['ready', [...SETTLED_AND_STARTED, { type: 'SUCCEED', output: OUTPUT }]],
  ['failed', [...SETTLED_AND_STARTED, { type: 'FAIL', step: 4, error: 'boom' }]],
  ['cancelled', [...SETTLED_AND_STARTED, { type: 'CANCEL' }]],
];

const REVIEW_PATH: JobEvent[] = [
  ...SETTLED_AND_STARTED,
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];

interface Call {
  job: VoiceJob;
  /** The file name of the recording, e.g. n1.webm. */
  file: string;
  resolve(text: string): void;
  reject(error: unknown): void;
}

/** A transcriber that records every job and lets the test settle each one by hand. */
function stubTranscriber() {
  const calls: Call[] = [];
  const transcriber = {
    enqueue(job: VoiceJob): Promise<VoiceTranscript> {
      return new Promise<VoiceTranscript>((resolve, reject) => {
        calls.push({
          job,
          file: basename(job.audioPath),
          resolve: (text) => resolve({ text }),
          reject,
        });
      });
    },
  };
  return {
    transcriber,
    calls,
    /** The recording's call; fails the test when there is none. */
    call(file: string): Call {
      const found = calls.find((entry) => entry.file === file);
      if (found === undefined) throw new Error(`No transcription was queued for ${file}`);
      return found;
    },
  };
}

const dirs: string[] = [];
const opened: StudioDb[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SetupOptions {
  styleNotes?: StyleNotesHook;
  seriesNotes?: SeriesNotesHook;
  transcriber?: { enqueue(job: VoiceJob): Promise<VoiceTranscript> };
  onTranscribed?: (note: ReviewNote, job: Job) => void;
  onSent?: (job: Job, notes: readonly ReviewNote[]) => void;
  reviewBlock?: (job: Job) => string | null;
  fixes?: NoteFixRules;
  routing?: NoteRouting;
}

function setup(options: SetupOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), 'studio-review-service-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const stub = stubTranscriber();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let counter = 0;
  const review: ReviewService = createReviewService({
    db,
    jobs,
    notes,
    bus,
    inboxPath,
    transcriber: options.transcriber ?? stub.transcriber,
    styleNotes: options.styleNotes,
    seriesNotes: options.seriesNotes,
    logger,
    ...(options.onTranscribed === undefined ? {} : { onTranscribed: options.onTranscribed }),
    ...(options.onSent === undefined ? {} : { onSent: options.onSent }),
    ...(options.reviewBlock === undefined ? {} : { reviewBlock: options.reviewBlock }),
    ...(options.fixes === undefined ? {} : { fixes: options.fixes }),
    ...(options.routing === undefined ? {} : { routing: options.routing }),
    clock,
    newId: () => `n${++counter}`,
  });

  /** A job in the given state (default review), with its folder made on disk. */
  function addJob(path: JobEvent[] = REVIEW_PATH, name = 'Spring menu', client = CLIENT): Job {
    const { job } = jobs.upsertFromScan(makeScan(client, name));
    for (const event of path) jobs.applyTransition(job.id, event);
    mkdirSync(join(inboxPath, job.relPath), { recursive: true });
    return jobs.get(job.id) as Job;
  }

  const dirOf = (job: Job): string => join(inboxPath, job.relPath);
  const upsertsOf = (): ReviewNote[] =>
    events.flatMap((event) => (event.type === 'note.upsert' ? [event.note] : []));
  const removesOf = (): string[] =>
    events.flatMap((event) => (event.type === 'note.remove' ? [event.noteId] : []));
  const noteEvents = (): ServerEvent[] =>
    events.filter((event) => event.type === 'note.upsert' || event.type === 'note.remove');

  return {
    inboxPath,
    clock,
    db,
    jobs,
    notes,
    bus,
    events,
    logger,
    review,
    stub,
    addJob,
    dirOf,
    upsertsOf,
    removesOf,
    noteEvents,
  };
}

type Harness = ReturnType<typeof setup>;

const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const voiceInput = (overrides: Partial<Parameters<ReviewService['addVoiceNote']>[1]> = {}) => ({
  audio: WEBM,
  type: 'audio/webm' as const,
  atSec: 7.8,
  audioSec: 12,
  ...overrides,
});

async function expectReviewError(
  work: () => unknown,
  status: number,
  message: string,
): Promise<void> {
  const error = await Promise.resolve()
    .then(work)
    .then(
      () => null,
      (err: unknown) => err,
    );
  expect(error).toBeInstanceOf(ReviewError);
  expect((error as ReviewError).status).toBe(status);
  expect((error as ReviewError).message).toBe(message);
}

/** Lets the promise callbacks of a settled transcription run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('the job must be in Review', () => {
  it('requireReview returns the job in review, JobNotFoundError for an unknown id', () => {
    const h = setup();
    const job = h.addJob();
    expect(h.review.requireReview(job.id)).toEqual(job);
    expect(() => h.review.requireReview('nobody')).toThrow(JobNotFoundError);
  });

  it.each(STATE_PATHS)(
    'every method answers 409 notInReview for a job that is %s',
    async (state, path) => {
      const h = setup();
      const job = h.addJob(path, `In ${state}`);
      const notInReview = (work: () => unknown) =>
        expectReviewError(work, 409, REVIEW_MESSAGES.notInReview);

      await notInReview(() => h.review.requireReview(job.id));
      await notInReview(() => h.review.listNotes(job.id));
      await notInReview(() => h.review.addTextNote(job.id, { atSec: 1, text: 'Note' }));
      await notInReview(() => h.review.addVoiceNote(job.id, voiceInput()));
      await notInReview(() => h.review.updateNote(job.id, 'n1', { text: 'Note' }));
      await notInReview(() => h.review.deleteNote(job.id, 'n1'));
      await notInReview(() => h.review.noteAudio(job.id, 'n1'));
      expect(h.noteEvents()).toEqual([]);
    },
  );

  it('answers JobNotFoundError for an unknown job on every method', async () => {
    const h = setup();
    await expect(Promise.resolve().then(() => h.review.listNotes('nobody'))).rejects.toThrow(
      JobNotFoundError,
    );
    await expect(
      Promise.resolve().then(() => h.review.addTextNote('nobody', { atSec: 1, text: 'x' })),
    ).rejects.toThrow(JobNotFoundError);
    await expect(h.review.addVoiceNote('nobody', voiceInput())).rejects.toThrow(JobNotFoundError);
    await expect(
      Promise.resolve().then(() => h.review.updateNote('nobody', 'n1', { text: 'x' })),
    ).rejects.toThrow(JobNotFoundError);
    await expect(h.review.deleteNote('nobody', 'n1')).rejects.toThrow(JobNotFoundError);
    await expect(h.review.noteAudio('nobody', 'n1')).rejects.toThrow(JobNotFoundError);
    await expect(h.review.sendNotes('nobody')).rejects.toThrow(JobNotFoundError);
    await expect(h.review.approve('nobody')).rejects.toThrow(JobNotFoundError);
  });
});

describe('text notes', () => {
  it('trims the text, stores the note unsent and publishes one note.upsert', () => {
    const h = setup();
    const job = h.addJob();

    const note = h.review.addTextNote(job.id, { atSec: 2.43, text: '  הכותרת יורדת מהר מדי.  \n' });

    expect(note).toMatchObject({
      id: 'n1',
      jobId: job.id,
      kind: 'text',
      atSec: 2.43,
      text: 'הכותרת יורדת מהר מדי.',
      round: null,
      sentAt: null,
      audioFile: null,
      transcriptStatus: null,
      addToStyle: false,
    });
    expect(h.review.listNotes(job.id)).toEqual([note]);
    expect(h.noteEvents()).toEqual([{ type: 'note.upsert', note }]);
  });

  it('takes exactly 2000 characters and refuses 2001', async () => {
    const h = setup();
    const job = h.addJob();

    expect(h.review.addTextNote(job.id, { atSec: 0, text: 'ש'.repeat(2000) }).text).toHaveLength(
      2000,
    );
    await expectReviewError(
      () => h.review.addTextNote(job.id, { atSec: 0, text: 'ש'.repeat(2001) }),
      400,
      REVIEW_MESSAGES.noteTooLong,
    );
    // Counted after the trim.
    expect(
      h.review.addTextNote(job.id, { atSec: 0, text: `  ${'a'.repeat(2000)}  ` }).text,
    ).toHaveLength(2000);
    expect(h.upsertsOf()).toHaveLength(2);
  });

  it('refuses an empty note', async () => {
    const h = setup();
    const job = h.addJob();

    await expectReviewError(
      () => h.review.addTextNote(job.id, { atSec: 0, text: '   ' }),
      400,
      REVIEW_MESSAGES.noteEmpty,
    );
    await expectReviewError(
      () => h.review.addTextNote(job.id, { atSec: 0, text: '' }),
      400,
      REVIEW_MESSAGES.noteEmpty,
    );
    expect(h.noteEvents()).toEqual([]);
    expect(h.notes.listUnsent(job.id)).toEqual([]);
  });

  it('lists the notes by atSec', () => {
    const h = setup();
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 9, text: 'Late' });
    h.review.addTextNote(job.id, { atSec: 1, text: 'Early' });

    expect(h.review.listNotes(job.id).map((note) => note.text)).toEqual(['Early', 'Late']);
  });
});

describe('voice notes', () => {
  it('saves the recording under edit/review/voice/, stores a pending note and starts the transcription', async () => {
    const h = setup();
    const job = h.addJob();

    const note = await h.review.addVoiceNote(job.id, voiceInput());

    expect(note).toMatchObject({
      id: 'n1',
      kind: 'voice',
      atSec: 7.8,
      audioSec: 12,
      audioFile: 'edit/review/voice/n1.webm',
      transcriptStatus: 'pending',
      text: null,
      round: null,
    });
    const path = join(h.dirOf(job), 'edit', 'review', 'voice', 'n1.webm');
    expect([...readFileSync(path)]).toEqual([...WEBM]);
    expect(existsSync(join(dirname(path), '.n1.webm.tmp'))).toBe(false);
    expect(h.upsertsOf()).toEqual([note]);
    expect(h.stub.calls).toHaveLength(1);
    const { job: queued } = h.stub.call('n1.webm');
    expect(queued.audioPath).toBe(path);
    expect(queued.outDir).toBe(join(h.dirOf(job), 'edit', 'review', 'voice'));
    expect(queued.signal).toBeInstanceOf(AbortSignal);
    expect(queued.language).toBeUndefined();
    expect('language' in queued).toBe(false);
  });

  it('names an audio/mp4 recording .m4a', async () => {
    const h = setup();
    const job = h.addJob();

    const note = await h.review.addVoiceNote(job.id, voiceInput({ type: 'audio/mp4' }));

    expect(note.audioFile).toBe('edit/review/voice/n1.m4a');
    expect(existsSync(join(h.dirOf(job), 'edit/review/voice/n1.m4a'))).toBe(true);
    expect(h.stub.call('n1.m4a').job.audioPath).toBe(
      join(h.dirOf(job), 'edit/review/voice/n1.m4a'),
    );
  });

  it('removes the recording and stores nothing when the job leaves review while it is written', async () => {
    const h = setup();
    const job = h.addJob();

    const pending = h.review.addVoiceNote(job.id, voiceInput());
    h.jobs.applyTransition(job.id, { type: 'PREVIEW_MISSING' });

    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(h.dirOf(job), 'edit/review/voice/n1.webm'))).toBe(false);
    expect(h.notes.listUnsent(job.id)).toEqual([]);
    expect(h.noteEvents()).toEqual([]);
    expect(h.stub.calls).toEqual([]);
  });

  it('removes the recording when the note cannot be stored', async () => {
    const h = setup();
    const job = h.addJob();
    vi.spyOn(h.notes, 'create').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(h.review.addVoiceNote(job.id, voiceInput())).rejects.toThrow('disk full');

    expect(existsSync(join(h.dirOf(job), 'edit/review/voice/n1.webm'))).toBe(false);
    expect(h.stub.calls).toEqual([]);
  });
});

describe('transcription', () => {
  async function pendingNote(h: Harness) {
    const job = h.addJob();
    const note = await h.review.addVoiceNote(job.id, voiceInput());
    return { job, note };
  }

  it('a transcript that arrives makes the note done, with the text, and publishes it once', async () => {
    const h = setup();
    const { note } = await pendingNote(h);

    h.stub.call('n1.webm').resolve('כאן הכתוביות מכסות את הידיים');
    await flush();

    expect(h.notes.get(note.id)).toMatchObject({
      transcriptStatus: 'done',
      text: 'כאן הכתוביות מכסות את הידיים',
    });
    const upserts = h.upsertsOf();
    expect(upserts).toHaveLength(2);
    expect(upserts[1]).toEqual(h.notes.get(note.id));
  });

  it("an iPhone's recording (audio/mp4, kept as .m4a) gets its transcript like Chrome's", async () => {
    const h = setup();
    const job = h.addJob();
    const note = await h.review.addVoiceNote(job.id, voiceInput({ type: 'audio/mp4', atSec: 21 }));
    expect(note).toMatchObject({
      audioFile: 'edit/review/voice/n1.m4a',
      transcriptStatus: 'pending',
      atSec: 21,
    });

    h.stub.call('n1.m4a').resolve('לחתוך את השוט של המדרגות, הוא ארוך מדי.');
    await flush();

    expect(h.notes.get(note.id)).toMatchObject({
      transcriptStatus: 'done',
      text: 'לחתוך את השוט של המדרגות, הוא ארוך מדי.',
      atSec: 21,
    });
    expect(h.upsertsOf()).toHaveLength(2);
    expect(h.upsertsOf()[1]).toEqual(h.notes.get(note.id));
  });

  it('reports a transcribed note with its job for the usage log, and not a failed one', async () => {
    const onTranscribed = vi.fn();
    const h = setup({ onTranscribed });
    const { note } = await pendingNote(h);
    h.stub.call('n1.webm').resolve('Cut the intro');
    await flush();
    expect(onTranscribed).toHaveBeenCalledOnce();
    expect(onTranscribed.mock.calls[0]?.[0]).toMatchObject({ id: note.id });
    expect(onTranscribed.mock.calls[0]?.[1]).toMatchObject({ id: note.jobId });

    const failing = vi.fn();
    const h2 = setup({ onTranscribed: failing });
    await pendingNote(h2);
    h2.stub.call('n1.webm').reject(new TranscriptionError('failed', 'Transcription failed.'));
    await flush();
    expect(failing).not.toHaveBeenCalled();
  });

  it.each([
    ['timed_out', new TranscriptionError('timed_out', 'The transcription timed out.')],
    ['no_speech', new TranscriptionError('no_speech', 'No speech was heard.')],
    ['failed', new TranscriptionError('failed', 'Transcription failed.')],
    ['a plain Error', new Error('something unexpected')],
  ])('%s makes the note failed and publishes it once', async (_label, error) => {
    const h = setup();
    const { note } = await pendingNote(h);

    h.stub.call('n1.webm').reject(error);
    await flush();

    expect(h.notes.get(note.id)).toMatchObject({ transcriptStatus: 'failed', text: null });
    expect(h.upsertsOf()).toHaveLength(2);
    expect(h.upsertsOf()[1]?.transcriptStatus).toBe('failed');
  });

  it('a transcriber that throws at once fails the note too', async () => {
    const h = setup({
      transcriber: {
        enqueue() {
          throw new Error('cannot start');
        },
      },
    });
    const job = h.addJob();

    const note = await h.review.addVoiceNote(job.id, voiceInput());
    await flush();

    expect(note.transcriptStatus).toBe('pending');
    expect(h.notes.get(note.id)?.transcriptStatus).toBe('failed');
    expect(h.upsertsOf()).toHaveLength(2);
  });

  it.each(['cancelled', 'stopped'] as const)(
    '%s leaves the note pending and publishes nothing',
    async (code) => {
      const h = setup();
      const { note } = await pendingNote(h);

      h.stub.call('n1.webm').reject(new TranscriptionError(code, 'Stopped.'));
      await flush();

      expect(h.notes.get(note.id)?.transcriptStatus).toBe('pending');
      expect(h.upsertsOf()).toHaveLength(1);
      // The next boot transcribes it again.
      h.review.resumeTranscriptions();
      expect(h.stub.calls).toHaveLength(2);
    },
  );

  it('knows every code the transcriber can reject with', () => {
    expect([...TRANSCRIPTION_ERROR_CODES].sort()).toEqual(
      ['cancelled', 'failed', 'no_speech', 'stopped', 'timed_out'].sort(),
    );
  });

  it('ignores a result that arrives for a note that is gone', async () => {
    const h = setup();
    const { job, note } = await pendingNote(h);
    h.notes.remove(note.id);

    h.stub.call('n1.webm').resolve('Too late');
    await flush();

    expect(h.notes.get(note.id)).toBeNull();
    expect(h.upsertsOf()).toHaveLength(1);
    expect(h.notes.listUnsent(job.id)).toEqual([]);
  });
});

describe('updateNote', () => {
  it('turns Add to style on and off and publishes each change', () => {
    const h = setup();
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    expect(h.review.updateNote(job.id, note.id, { addToStyle: true }).addToStyle).toBe(true);
    expect(h.review.updateNote(job.id, note.id, { addToStyle: false }).addToStyle).toBe(false);

    expect(h.upsertsOf().map((entry) => entry.addToStyle)).toEqual([false, true, false]);
  });

  describe('Add to series', () => {
    const on: SeriesNotesHook = { enabled: true, append: async () => {} };
    const EPISODE = { seriesId: '622212180eef', episode: 6, pinned: false };

    it('turns Series on and off on an episode and publishes each change', () => {
      const h = setup({ seriesNotes: on });
      const job = h.addJob();
      h.jobs.setSeries(job.id, EPISODE);
      const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

      expect(h.review.updateNote(job.id, note.id, { addToSeries: true })).toMatchObject({
        addToSeries: true,
        addToStyle: false,
      });
      expect(h.review.updateNote(job.id, note.id, { addToSeries: false }).addToSeries).toBe(false);

      expect(h.upsertsOf().map((entry) => entry.addToSeries)).toEqual([false, true, false]);
    });

    it('keeps Series and Style apart: a note can be marked both', () => {
      const h = setup({ seriesNotes: on });
      const job = h.addJob();
      h.jobs.setSeries(job.id, EPISODE);
      const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

      h.review.updateNote(job.id, note.id, { addToStyle: true });
      const both = h.review.updateNote(job.id, note.id, { addToSeries: true });
      const styleOff = h.review.updateNote(job.id, note.id, { addToStyle: false });

      expect(both).toMatchObject({ addToStyle: true, addToSeries: true });
      expect(styleOff).toMatchObject({ addToStyle: false, addToSeries: true });
    });

    it('answers 422 for a job in no series, and changes nothing in the same request', async () => {
      const h = setup({ seriesNotes: on });
      const job = h.addJob();
      const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });
      const published = h.upsertsOf().length;

      await expectReviewError(
        () =>
          h.review.updateNote(job.id, note.id, {
            text: 'Edited',
            addToStyle: true,
            addToSeries: true,
          }),
        422,
        REVIEW_MESSAGES.notInSeries,
      );

      expect(h.notes.get(note.id)).toMatchObject({
        text: 'Typed',
        addToStyle: false,
        addToSeries: false,
      });
      expect(h.upsertsOf()).toHaveLength(published);
    });

    it.each([
      ['by default', undefined],
      ['when the hook says so', { enabled: false, append: async () => {} }],
    ])(
      'answers 422 "Series are off." while series are off, even on an episode (%s)',
      async (_label, hook) => {
        const h = setup({ seriesNotes: hook });
        const job = h.addJob();
        h.jobs.setSeries(job.id, EPISODE);
        const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

        await expectReviewError(
          () => h.review.updateNote(job.id, note.id, { addToSeries: true }),
          422,
          SERIES_MESSAGES.off,
        );

        expect(h.notes.get(note.id)?.addToSeries).toBe(false);
      },
    );

    it('lets a mark that can’t be kept be cleared: false is never refused', () => {
      const h = setup();
      const job = h.addJob();
      const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });
      h.notes.update(note.id, { addToSeries: true });

      expect(h.review.updateNote(job.id, note.id, { addToSeries: false }).addToSeries).toBe(false);
    });

    it('answers 404 for an unknown note before it looks at the series', async () => {
      const h = setup();
      const job = h.addJob();

      await expectReviewError(
        () => h.review.updateNote(job.id, 'nope', { addToSeries: true }),
        404,
        noteNotFoundMessage('nope'),
      );
    });
  });

  it('changes the text of a typed note, trimmed and checked', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    expect(h.review.updateNote(job.id, note.id, { text: '  Edited  ' })).toMatchObject({
      text: 'Edited',
      addToStyle: false,
    });
    await expectReviewError(
      () => h.review.updateNote(job.id, note.id, { text: '  ' }),
      400,
      REVIEW_MESSAGES.noteEmpty,
    );
    await expectReviewError(
      () => h.review.updateNote(job.id, note.id, { text: 'x'.repeat(2001) }),
      400,
      REVIEW_MESSAGES.noteTooLong,
    );
    expect(h.notes.get(note.id)?.text).toBe('Edited');
  });

  it('refuses the text of a voice note, and changes nothing else in the same request', async () => {
    const h = setup();
    const job = h.addJob();
    const note = await h.review.addVoiceNote(job.id, voiceInput());

    await expectReviewError(
      () => h.review.updateNote(job.id, note.id, { text: 'Mine', addToStyle: true }),
      400,
      REVIEW_MESSAGES.voiceTextFixed,
    );
    expect(h.review.updateNote(job.id, note.id, { addToStyle: true }).addToStyle).toBe(true);
    expect(h.notes.get(note.id)?.text).toBeNull();
  });

  it("answers 404 for a sent note, another job's note and an unknown one", async () => {
    const h = setup();
    const job = h.addJob();
    const other = h.addJob(REVIEW_PATH, 'Summer menu');
    h.notes.create({ id: 'sent', jobId: job.id, kind: 'text', atSec: 1, text: 'Sent' });
    h.notes.markSent(job.id, ['sent'], 1, '2026-10-20T10:30:00.000Z');
    h.notes.create({ id: 'theirs', jobId: other.id, kind: 'text', atSec: 1, text: 'Theirs' });

    for (const id of ['sent', 'theirs', 'n9']) {
      await expectReviewError(
        () => h.review.updateNote(job.id, id, { text: 'Changed' }),
        404,
        noteNotFoundMessage(id),
      );
    }
    expect(noteNotFoundMessage('n9')).toBe('Note n9 not found');
    expect(h.notes.get('sent')?.text).toBe('Sent');
    expect(h.notes.get('theirs')?.text).toBe('Theirs');
  });
});

describe('deleteNote', () => {
  it('removes the row, stops the transcription, removes the audio and the transcript, and publishes note.remove once', async () => {
    const h = setup();
    const job = h.addJob();
    const note = await h.review.addVoiceNote(job.id, voiceInput());
    const voiceDir = join(h.dirOf(job), 'edit/review/voice');
    mkdirSync(join(voiceDir, 'transcripts'), { recursive: true });
    writeFileSync(join(voiceDir, 'transcripts', 'n1.json'), '{}');
    const { signal } = h.stub.call('n1.webm').job;
    expect(signal?.aborted).toBe(false);

    await h.review.deleteNote(job.id, note.id);

    expect(h.notes.get(note.id)).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(existsSync(join(voiceDir, 'n1.webm'))).toBe(false);
    expect(existsSync(join(voiceDir, 'transcripts', 'n1.json'))).toBe(false);
    expect(h.removesOf()).toEqual(['n1']);
    expect(h.events.at(-1)).toEqual({ type: 'note.remove', jobId: job.id, noteId: 'n1' });
  });

  it('a transcript that resolves after the delete publishes nothing and does not bring the note back', async () => {
    const h = setup();
    const job = h.addJob();
    const note = await h.review.addVoiceNote(job.id, voiceInput());
    await h.review.deleteNote(job.id, note.id);
    const before = h.events.length;

    h.stub.call('n1.webm').resolve('Late words');
    await flush();

    expect(h.notes.get(note.id)).toBeNull();
    expect(h.events).toHaveLength(before);
  });

  it('a transcription rejected as cancelled after the delete publishes nothing either', async () => {
    const h = setup();
    const job = h.addJob();
    const note = await h.review.addVoiceNote(job.id, voiceInput());
    await h.review.deleteNote(job.id, note.id);
    const before = h.events.length;

    h.stub.call('n1.webm').reject(new TranscriptionError('cancelled', 'Cancelled.'));
    await flush();

    expect(h.events).toHaveLength(before);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('deletes a typed note', async () => {
    const h = setup();
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    await h.review.deleteNote(job.id, note.id);

    expect(h.review.listNotes(job.id)).toEqual([]);
    expect(h.removesOf()).toEqual([note.id]);
  });

  it('answers 404 for an unknown note and for one that is sent', async () => {
    const h = setup();
    const job = h.addJob();
    h.notes.create({ id: 'sent', jobId: job.id, kind: 'text', atSec: 1, text: 'Sent' });
    h.notes.markSent(job.id, ['sent'], 1, '2026-10-20T10:30:00.000Z');

    await expectReviewError(() => h.review.deleteNote(job.id, 'n9'), 404, 'Note n9 not found');
    await expectReviewError(() => h.review.deleteNote(job.id, 'sent'), 404, 'Note sent not found');
    expect(h.notes.get('sent')).not.toBeNull();
    expect(h.removesOf()).toEqual([]);
  });

  it('logs and carries on when a file cannot be removed', async () => {
    const h = setup();
    const job = h.addJob();
    const note = await h.review.addVoiceNote(job.id, voiceInput());
    // The audio path is a non-empty folder now: rm without `recursive` refuses it.
    const audio = join(h.dirOf(job), note.audioFile as string);
    rmSync(audio);
    mkdirSync(audio);
    writeFileSync(join(audio, 'inside'), 'x');

    await expect(h.review.deleteNote(job.id, note.id)).resolves.toBeUndefined();

    expect(h.logger.error).toHaveBeenCalled();
    expect(h.notes.get(note.id)).toBeNull();
  });
});

describe('job.remove on the bus', () => {
  it("aborts the removed job's transcriptions and only those", async () => {
    const h = setup();
    const a = h.addJob(REVIEW_PATH, 'Job A');
    const b = h.addJob(REVIEW_PATH, 'Job B');
    await h.review.addVoiceNote(a.id, voiceInput());
    await h.review.addVoiceNote(b.id, voiceInput());
    const signalA = h.stub.call('n1.webm').job.signal;
    const signalB = h.stub.call('n2.webm').job.signal;

    h.bus.publish({ type: 'job.remove', id: a.id });

    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);
  });
});

describe('resumeTranscriptions and stop', () => {
  it('enqueues each pending voice note of an existing job once, however often it is called', () => {
    const h = setup();
    const job = h.addJob();
    const voice = (id: string, jobId: string) =>
      h.notes.create({
        id,
        jobId,
        kind: 'voice',
        atSec: 1,
        audioFile: `edit/review/voice/${id}.webm`,
        audioSec: 3,
      });
    voice('p1', job.id);
    voice('p2', job.id);
    voice('ghost', 'a-job-that-is-gone');
    h.notes.create({ id: 't1', jobId: job.id, kind: 'text', atSec: 1, text: 'Typed' });
    voice('d1', job.id);
    h.notes.setTranscript('d1', { status: 'done', text: 'Done already' });

    h.review.resumeTranscriptions();
    h.review.resumeTranscriptions();

    expect(h.stub.calls.map((call) => call.file)).toEqual(['p1.webm', 'p2.webm']);
    expect(h.stub.call('p1.webm').job.audioPath).toBe(
      join(h.dirOf(job), 'edit/review/voice/p1.webm'),
    );
    expect(h.stub.call('p1.webm').job.language).toBeUndefined();
  });

  it('enqueues nothing after stop()', () => {
    const h = setup();
    const job = h.addJob();
    h.notes.create({
      id: 'p1',
      jobId: job.id,
      kind: 'voice',
      atSec: 1,
      audioFile: 'edit/review/voice/p1.webm',
      audioSec: 3,
    });

    h.review.stop();
    h.review.resumeTranscriptions();

    expect(h.stub.calls).toEqual([]);
  });

  it('stops listening to the bus', async () => {
    const h = setup();
    const job = h.addJob();
    await h.review.addVoiceNote(job.id, voiceInput());
    const { signal } = h.stub.call('n1.webm').job;

    h.review.stop();
    h.bus.publish({ type: 'job.remove', id: job.id });

    expect(signal?.aborted).toBe(false);
  });
});

describe('noteAudio', () => {
  it('gives the real path and the Content-Type of a recording', async () => {
    const h = setup();
    const job = h.addJob();
    await h.review.addVoiceNote(job.id, voiceInput());
    await h.review.addVoiceNote(job.id, voiceInput({ type: 'audio/mp4' }));

    const webm = await h.review.noteAudio(job.id, 'n1');
    const m4a = await h.review.noteAudio(job.id, 'n2');

    expect(webm.contentType).toBe('audio/webm');
    expect(m4a.contentType).toBe('audio/mp4');
    expect(basename(webm.path)).toBe('n1.webm');
    expect(readFileSync(webm.path)).toEqual(Buffer.from(WEBM));
  });

  it("answers 404 for an unknown note, another job's note, a text note and a missing file", async () => {
    const h = setup();
    const job = h.addJob();
    const other = h.addJob(REVIEW_PATH, 'Summer menu');
    const typed = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });
    const theirs = await h.review.addVoiceNote(other.id, voiceInput());
    const mine = await h.review.addVoiceNote(job.id, voiceInput());
    rmSync(join(h.dirOf(job), mine.audioFile as string));

    await expectReviewError(() => h.review.noteAudio(job.id, 'n9'), 404, 'Note n9 not found');
    await expectReviewError(
      () => h.review.noteAudio(job.id, theirs.id),
      404,
      noteNotFoundMessage(theirs.id),
    );
    await expectReviewError(
      () => h.review.noteAudio(job.id, typed.id),
      404,
      REVIEW_MESSAGES.noAudio,
    );
    await expectReviewError(
      () => h.review.noteAudio(job.id, mine.id),
      404,
      REVIEW_MESSAGES.audioMissing,
    );
  });
});

const GOLDEN_JOB = 'פרומו לסוף השבוע';
const GOLDEN_CLIENT = 'מאפיית הצפון';
const GOLDEN = `# Review notes, round 1: ${GOLDEN_JOB} (${GOLDEN_CLIENT})

The owner watched the preview (edit/preview/) and wrote these notes. Each time is a moment on the preview's timeline.

- 0:02.4 — הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.
- 0:07.8 — voice note (edit/review/voice/n2.webm): "כאן הכתוביות מכסות את הידיים של יוסי. להעלות אותן קצת, או לבחור שוט אחר."
- 0:15.6 — לחתוך את השתיקה לפני "בסוף השבוע".
- 0:21.0 — voice note (edit/review/voice/n4.m4a): not transcribed
`;

/** The golden round: two typed notes and two voice notes, one transcribed and one failed. */
async function goldenRound(h: Harness, options: { transcribe?: boolean } = {}) {
  const job = h.addJob(REVIEW_PATH, GOLDEN_JOB, GOLDEN_CLIENT);
  h.review.addTextNote(job.id, {
    atSec: 2.43,
    text: 'הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.',
  });
  await h.review.addVoiceNote(job.id, voiceInput({ atSec: 7.8 }));
  h.review.addTextNote(job.id, { atSec: 15.62, text: 'לחתוך את השתיקה לפני "בסוף השבוע".' });
  await h.review.addVoiceNote(job.id, voiceInput({ type: 'audio/mp4', atSec: 21 }));
  if (options.transcribe !== false) {
    h.stub
      .call('n2.webm')
      .resolve('כאן הכתוביות מכסות את הידיים של יוסי. להעלות אותן קצת, או לבחור שוט אחר.');
    h.stub.call('n4.m4a').reject(new TranscriptionError('failed', 'Transcription failed.'));
    await flush();
  }
  return job;
}

describe('sendNotes', () => {
  it('writes the golden round file, queues the revise run, stamps the notes and publishes four note.remove', async () => {
    const h = setup();
    const job = await goldenRound(h);

    const sent = await h.review.sendNotes(job.id);

    expect(readFileSync(join(h.dirOf(job), 'edit/review/round-1.md'), 'utf8')).toBe(GOLDEN);
    expect(sent).toMatchObject({ state: 'queued', runKind: 'revise', round: 1 });
    expect(h.jobs.get(job.id)).toEqual(sent);
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      expect(h.notes.get(id)).toMatchObject({
        round: 1,
        sentAt: h.clock().toISOString(),
      });
    }
    expect(h.notes.listUnsent(job.id)).toEqual([]);
    expect(h.removesOf()).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(existsSync(join(h.dirOf(job), 'edit/review/.round-1.md.tmp'))).toBe(false);
  });

  it('writes the round file before the job moves on', async () => {
    const h = setup();
    const job = await goldenRound(h);
    const original = h.jobs.applyTransition.bind(h.jobs);
    const seen: boolean[] = [];
    vi.spyOn(h.jobs, 'applyTransition').mockImplementation((id, event) => {
      seen.push(existsSync(join(h.dirOf(job), 'edit/review/round-1.md')));
      return original(id, event);
    });

    await h.review.sendNotes(job.id);

    expect(seen).toEqual([true]);
  });

  it('is atomic when the transition fails: no round file, notes unsent, job still in review', async () => {
    const h = setup();
    const job = await goldenRound(h);
    vi.spyOn(h.jobs, 'applyTransition').mockImplementation(() => {
      throw new Error('disk on fire');
    });

    await expect(h.review.sendNotes(job.id)).rejects.toThrow('disk on fire');

    expect(existsSync(join(h.dirOf(job), 'edit/review/round-1.md'))).toBe(false);
    expect(h.notes.listUnsent(job.id)).toHaveLength(4);
    expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0, runKind: 'edit' });
    expect(h.removesOf()).toEqual([]);
  });

  it('is atomic when the stamping fails: the transition is rolled back too', async () => {
    const h = setup();
    const job = await goldenRound(h);
    vi.spyOn(h.notes, 'markSent').mockImplementation(() => {
      throw new Error('stamp failed');
    });

    await expect(h.review.sendNotes(job.id)).rejects.toThrow('stamp failed');

    expect(existsSync(join(h.dirOf(job), 'edit/review/round-1.md'))).toBe(false);
    expect(h.notes.listUnsent(job.id)).toHaveLength(4);
    expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0, runKind: 'edit' });
    expect(h.removesOf()).toEqual([]);
  });

  it('answers 409 notesChanged when the notes change while the file is written', async () => {
    const h = setup();
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'First' });
    const original = h.notes.listUnsent.bind(h.notes);
    let calls = 0;
    vi.spyOn(h.notes, 'listUnsent').mockImplementation((jobId) => {
      const result = original(jobId);
      calls += 1;
      if (calls === 1) {
        h.notes.create({ id: 'late', jobId, kind: 'text', atSec: 2, text: 'Late' });
      }
      return result;
    });

    await expectReviewError(() => h.review.sendNotes(job.id), 409, REVIEW_MESSAGES.notesChanged);

    expect(existsSync(join(h.dirOf(job), 'edit/review/round-1.md'))).toBe(false);
    expect(h.jobs.get(job.id)?.state).toBe('review');
    expect(h.notes.get('late')).toMatchObject({ round: null });
    expect(h.notes.get('n1')).toMatchObject({ round: null });
  });

  it('answers 409 noNotesToSend without an unsent note', async () => {
    const h = setup();
    const job = h.addJob();

    await expectReviewError(() => h.review.sendNotes(job.id), 409, REVIEW_MESSAGES.noNotesToSend);

    expect(h.jobs.get(job.id)?.state).toBe('review');
    expect(existsSync(join(h.dirOf(job), 'edit/review'))).toBe(false);
  });

  it('answers 409 waitForTranscripts while a voice note is pending, and writes nothing', async () => {
    const h = setup();
    const job = await goldenRound(h, { transcribe: false });

    await expectReviewError(
      () => h.review.sendNotes(job.id),
      409,
      REVIEW_MESSAGES.waitForTranscripts,
    );

    expect(existsSync(join(h.dirOf(job), 'edit/review/round-1.md'))).toBe(false);
    expect(h.jobs.get(job.id)?.state).toBe('review');
    expect(h.notes.listUnsent(job.id)).toHaveLength(4);
  });

  it('throws InvalidTransition for a job that is not in review', async () => {
    const h = setup();
    const job = h.addJob([{ type: 'SETTLED' }]);

    await expect(h.review.sendNotes(job.id)).rejects.toBeInstanceOf(InvalidTransition);
    await expect(h.review.sendNotes(job.id)).rejects.toMatchObject({ state: 'queued' });
  });

  it('a second round writes round-2.md and stamps 2', async () => {
    const h = setup();
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Round one' });
    await h.review.sendNotes(job.id);
    // The revise run ends in review again.
    h.jobs.applyTransition(job.id, { type: 'START' });
    h.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
    h.review.addTextNote(job.id, { atSec: 3, text: 'Round two' });

    const sent = await h.review.sendNotes(job.id);

    expect(sent).toMatchObject({ round: 2, runKind: 'revise', state: 'queued' });
    const second = readFileSync(join(h.dirOf(job), 'edit/review/round-2.md'), 'utf8');
    expect(second).toContain('Review notes, round 2: Spring menu (Northwind Bakery)');
    expect(second).toContain('- 0:03.0 — Round two');
    expect(second).not.toContain('Round one');
    expect(h.notes.get('n2')).toMatchObject({ round: 2 });
    expect(h.notes.get('n1')).toMatchObject({ round: 1 });
    expect(readFileSync(join(h.dirOf(job), 'edit/review/round-1.md'), 'utf8')).toContain(
      'Round one',
    );
  });

  it('two Sends at once: the first one wins and the second finds the job queued', async () => {
    const h = setup();
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Only once' });

    const results = await Promise.allSettled([
      h.review.sendNotes(job.id),
      h.review.sendNotes(job.id),
    ]);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTransition);
    expect(existsSync(join(h.dirOf(job), 'edit/review/round-1.md'))).toBe(true);
    expect(h.jobs.get(job.id)?.round).toBe(1);
  });

  describe('onSent', () => {
    it('is told which job and notes were sent, after they are stamped, and a throwing hook never fails the Send', async () => {
      const onSent = vi.fn((_job: Job, _notes: readonly ReviewNote[]) => {});
      const h = setup({ onSent });
      const job = h.addJob();
      h.review.addTextNote(job.id, { atSec: 1, text: 'Intro too long' });
      h.review.addTextNote(job.id, { atSec: 2, text: 'Music too loud' });

      const sent = await h.review.sendNotes(job.id);

      expect(onSent).toHaveBeenCalledTimes(1);
      const [sentJob, sentNotes] = onSent.mock.calls[0] ?? [];
      expect(sentJob).toEqual(sent);
      expect(sentNotes?.map((note) => [note.id, note.round])).toEqual([
        ['n1', 1],
        ['n2', 1],
      ]);

      const broken = setup({
        onSent: () => {
          throw new Error('topics are broken');
        },
      });
      const job2 = broken.addJob();
      broken.review.addTextNote(job2.id, { atSec: 1, text: 'Intro too long' });
      expect((await broken.review.sendNotes(job2.id)).state).toBe('queued');
      expect(broken.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('is not called when the Send fails', async () => {
      const onSent = vi.fn();
      const h = setup({ onSent });
      const job = await goldenRound(h);
      vi.spyOn(h.notes, 'markSent').mockImplementation(() => {
        throw new Error('stamp failed');
      });

      await expect(h.review.sendNotes(job.id)).rejects.toThrow('stamp failed');

      expect(onSent).not.toHaveBeenCalled();
    });
  });

  describe('Add to style', () => {
    function hook(append: StyleNotesHook['append'] = async () => {}) {
      const spy = vi.fn(append);
      return { hook: { append: spy } satisfies StyleNotesHook, spy };
    }

    it('calls the hook once, with the queued job and only the notes marked Add to style', async () => {
      const { hook: styleNotes, spy } = hook();
      const h = setup({ styleNotes });
      const job = h.addJob();
      h.review.addTextNote(job.id, { atSec: 1, text: 'Keep' });
      h.review.addTextNote(job.id, { atSec: 2, text: 'Skip' });
      h.review.addTextNote(job.id, { atSec: 3, text: 'Also keep' });
      h.review.updateNote(job.id, 'n1', { addToStyle: true });
      h.review.updateNote(job.id, 'n3', { addToStyle: true });

      const sent = await h.review.sendNotes(job.id);

      expect(spy).toHaveBeenCalledTimes(1);
      const [calledJob, calledNotes] = spy.mock.calls[0] ?? [];
      expect(calledJob).toEqual(sent);
      expect(calledJob).toMatchObject({ state: 'queued', round: 1 });
      expect(calledNotes?.map((note) => note.id)).toEqual(['n1', 'n3']);
      for (const note of calledNotes ?? [])
        expect(note).toMatchObject({ round: 1, addToStyle: true });
    });

    it('is not called when no note is marked', async () => {
      const { hook: styleNotes, spy } = hook();
      const h = setup({ styleNotes });
      const job = h.addJob();
      h.review.addTextNote(job.id, { atSec: 1, text: 'Plain' });

      await h.review.sendNotes(job.id);

      expect(spy).not.toHaveBeenCalled();
    });

    it('never fails the Send: a throwing hook is logged', async () => {
      const { hook: styleNotes, spy } = hook(async () => {
        throw new Error('style is broken');
      });
      const h = setup({ styleNotes });
      const job = h.addJob();
      h.review.addTextNote(job.id, { atSec: 1, text: 'Keep' });
      h.review.updateNote(job.id, 'n1', { addToStyle: true });

      const sent = await h.review.sendNotes(job.id);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(sent.state).toBe('queued');
      expect(h.logger.error).toHaveBeenCalledTimes(1);
      expect(h.notes.get('n1')).toMatchObject({ round: 1 });
    });

    it('is not called when the Send fails', async () => {
      const { hook: styleNotes, spy } = hook();
      const h = setup({ styleNotes });
      const job = h.addJob();
      h.review.addTextNote(job.id, { atSec: 1, text: 'Keep' });
      h.review.updateNote(job.id, 'n1', { addToStyle: true });
      vi.spyOn(h.jobs, 'applyTransition').mockImplementation(() => {
        throw new Error('nope');
      });

      await expect(h.review.sendNotes(job.id)).rejects.toThrow('nope');

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Series plan §6. Who may mark a note Series is updateNote's rule (tested there); here the mark is
  // set in the repository.
  describe('Add to series', () => {
    function hook(append: SeriesNotesHook['append'] = async () => {}) {
      const spy = vi.fn(append);
      return { hook: { enabled: true, append: spy } satisfies SeriesNotesHook, spy };
    }

    it('calls the hook once, after the style’s, with only the notes marked Series', async () => {
      const order: string[] = [];
      const { hook: seriesNotes, spy } = hook(async () => {
        order.push('series');
      });
      const styleNotes: StyleNotesHook = {
        append: async () => {
          order.push('style');
        },
      };
      const h = setup({ styleNotes, seriesNotes });
      const job = h.addJob();
      h.review.addTextNote(job.id, { atSec: 1, text: 'Both' });
      h.review.addTextNote(job.id, { atSec: 2, text: 'Plain' });
      h.review.addTextNote(job.id, { atSec: 3, text: 'Series only' });
      h.notes.update('n1', { addToStyle: true, addToSeries: true });
      h.notes.update('n3', { addToSeries: true });

      const sent = await h.review.sendNotes(job.id);

      expect(order).toEqual(['style', 'series']);
      expect(spy).toHaveBeenCalledTimes(1);
      const [calledJob, calledNotes] = spy.mock.calls[0] ?? [];
      expect(calledJob).toEqual(sent);
      expect(calledNotes?.map((note) => note.id)).toEqual(['n1', 'n3']);
      for (const note of calledNotes ?? []) {
        expect(note).toMatchObject({ round: 1, addToSeries: true });
      }
    });

    it('is not called when no note is marked, and a throwing hook never fails the Send', async () => {
      const quiet = hook();
      const h1 = setup({ seriesNotes: quiet.hook });
      const job1 = h1.addJob();
      h1.review.addTextNote(job1.id, { atSec: 1, text: 'Plain' });
      await h1.review.sendNotes(job1.id);
      expect(quiet.spy).not.toHaveBeenCalled();

      const broken = hook(async () => {
        throw new Error('series is broken');
      });
      const h2 = setup({ seriesNotes: broken.hook });
      const job2 = h2.addJob();
      h2.review.addTextNote(job2.id, { atSec: 1, text: 'Series' });
      h2.notes.update('n1', { addToSeries: true });

      const sent = await h2.review.sendNotes(job2.id);

      expect(broken.spy).toHaveBeenCalledTimes(1);
      expect(sent.state).toBe('queued');
      expect(h2.logger.error).toHaveBeenCalledTimes(1);
    });
  });
});

describe('send notes while something blocks it (Soundtrack: a version of the music is being made)', () => {
  it('answers 409 with the blocker’s words, leaves the job in review and the notes unsent, and writes no round file', async () => {
    const reviewBlock = vi.fn(() => 'Music v3 is still being made.');
    const h = setup({ reviewBlock });
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Cut earlier' });

    await expectReviewError(() => h.review.sendNotes(job.id), 409, 'Music v3 is still being made.');

    expect(reviewBlock).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0 });
    expect(h.notes.countUnsent(job.id)).toBe(1);
    expect(existsSync(join(h.dirOf(job), 'edit', 'review', 'round-1.md'))).toBe(false);
  });

  it('is asked again inside the transaction: a make that starts while the round file is written still holds the Send', async () => {
    let calls = 0;
    // Free for the early look, busy by the time the notes are committed.
    const h = setup({
      reviewBlock: () => (++calls === 1 ? null : 'Music v3 is still being made.'),
    });
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Cut earlier' });

    await expectReviewError(() => h.review.sendNotes(job.id), 409, 'Music v3 is still being made.');

    expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0 });
    expect(h.notes.countUnsent(job.id)).toBe(1);
    // The round file written for the attempt is taken away again.
    expect(existsSync(join(h.dirOf(job), 'edit', 'review', 'round-1.md'))).toBe(false);
  });

  it('sends once the blocker lets go', async () => {
    let blocked: string | null = 'The music is being changed. Try again in a moment.';
    const h = setup({ reviewBlock: () => blocked });
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Cut earlier' });
    await expectReviewError(
      () => h.review.sendNotes(job.id),
      409,
      'The music is being changed. Try again in a moment.',
    );

    blocked = null;

    expect(await h.review.sendNotes(job.id)).toMatchObject({
      state: 'queued',
      runKind: 'revise',
      round: 1,
    });
  });

  it('is asked only for a job in review with notes to send', async () => {
    const reviewBlock = vi.fn(() => 'Music v3 is still being made.');
    const h = setup({ reviewBlock });
    const queued = h.addJob([{ type: 'SETTLED' }]);
    await expect(h.review.sendNotes(queued.id)).rejects.toThrow(InvalidTransition);
    const empty = h.addJob(REVIEW_PATH, 'Other');
    await expectReviewError(() => h.review.sendNotes(empty.id), 409, REVIEW_MESSAGES.noNotesToSend);
    expect(reviewBlock).not.toHaveBeenCalled();
  });
});

describe('approve', () => {
  it('answers 409 sendOrDeleteFirst while a note is unsent, and leaves the job alone', async () => {
    const h = setup();
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Unsent' });

    await expectReviewError(() => h.review.approve(job.id), 409, REVIEW_MESSAGES.sendOrDeleteFirst);

    expect(h.jobs.get(job.id)).toMatchObject({
      state: 'review',
      runKind: 'edit',
      approvedAt: null,
    });
  });

  it('queues the render run when there are no unsent notes', async () => {
    const h = setup();
    const job = h.addJob();

    const approved = await h.review.approve(job.id);

    expect(approved).toMatchObject({ state: 'queued', runKind: 'render' });
    expect(approved.approvedAt).toBe(h.clock().toISOString());
  });

  it('is not blocked by notes that were sent in an earlier round', async () => {
    const h = setup();
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Round one' });
    await h.review.sendNotes(job.id);
    h.jobs.applyTransition(job.id, { type: 'START' });
    h.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });

    expect(await h.review.approve(job.id)).toMatchObject({ state: 'queued', runKind: 'render' });
  });

  it('throws InvalidTransition for a job that is not in review', async () => {
    const h = setup();
    const job = h.addJob([{ type: 'SETTLED' }]);

    await expect(h.review.approve(job.id)).rejects.toThrow(InvalidTransition);
  });

  describe('while something blocks it (Soundtrack: a version of the music is being made)', () => {
    it('answers 409 with the blocker’s words and leaves the job in review', async () => {
      const reviewBlock = vi.fn(() => 'Music v3 is still being made.');
      const h = setup({ reviewBlock });
      const job = h.addJob();

      await expectReviewError(() => h.review.approve(job.id), 409, 'Music v3 is still being made.');

      expect(reviewBlock).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
      expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', approvedAt: null });
    });

    it('approves once the blocker lets go', async () => {
      let blocked: string | null = 'Music v3 is still being made.';
      const h = setup({ reviewBlock: () => blocked });
      const job = h.addJob();
      await expect(h.review.approve(job.id)).rejects.toThrow();

      blocked = null;

      expect(await h.review.approve(job.id)).toMatchObject({ state: 'queued', runKind: 'render' });
    });

    // QF4: a quick fix that runs must answer "busy", not "send or delete your notes".
    it('is asked only for a job in review, before the unsent-notes rule', async () => {
      const reviewBlock = vi.fn(() => 'Music v3 is still being made.');
      const h = setup({ reviewBlock });
      const queued = h.addJob([{ type: 'SETTLED' }]);
      await expect(h.review.approve(queued.id)).rejects.toThrow(InvalidTransition);
      expect(reviewBlock).not.toHaveBeenCalled();

      const job = h.addJob(REVIEW_PATH, 'Other');
      h.review.addTextNote(job.id, { atSec: 1, text: 'Unsent' });
      await expectReviewError(() => h.review.approve(job.id), 409, 'Music v3 is still being made.');
      expect(reviewBlock).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
      expect(h.notes.listUnsent(job.id)).toHaveLength(1);
    });
  });
});

describe('the quick fixes’ say over a note (QF3)', () => {
  /** Rules whose answers the test decides, recording what they were asked about. */
  function rules(answers: { edit?: string | null; remove?: string | null } = {}) {
    const asked = { edit: [] as string[], remove: [] as string[] };
    const fixes: NoteFixRules = {
      said: () => null,
      clearRound: async () => {},
      beforeEdit: (note) => {
        asked.edit.push(note.id);
        return answers.edit ?? null;
      },
      beforeDelete: async (note) => {
        asked.remove.push(note.id);
        return answers.remove ?? null;
      },
    };
    return { fixes, asked };
  }

  it('asks before a text change, and answers 409 with the rule’s words without changing the note', () => {
    const { fixes, asked } = rules({ edit: 'Undo the fix before changing this note.' });
    const h = setup({ fixes });
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });
    const published = h.upsertsOf().length;

    expect(() => h.review.updateNote(job.id, note.id, { text: 'New words' })).toThrow(ReviewError);
    try {
      h.review.updateNote(job.id, note.id, { text: 'New words' });
    } catch (err) {
      expect(err).toMatchObject({
        status: 409,
        message: 'Undo the fix before changing this note.',
      });
    }

    expect(asked.edit).toEqual([note.id, note.id]);
    expect(h.notes.get(note.id)?.text).toBe('Typed');
    expect(h.upsertsOf()).toHaveLength(published);
  });

  it('does not ask when the text stays the same or when something else changes', () => {
    const { fixes, asked } = rules({ edit: 'No.' });
    const h = setup({ fixes });
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    expect(h.review.updateNote(job.id, note.id, { text: '  Typed ' }).text).toBe('Typed');
    expect(h.review.updateNote(job.id, note.id, { addToStyle: true }).addToStyle).toBe(true);

    expect(asked.edit).toEqual([]);
  });

  it('changes the text when the rules let it', () => {
    const { fixes, asked } = rules();
    const h = setup({ fixes });
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    expect(h.review.updateNote(job.id, note.id, { text: 'New words' }).text).toBe('New words');
    expect(asked.edit).toEqual([note.id]);
  });

  it('asks before a delete, and keeps the note, its audio and its event when the answer is 409', async () => {
    const { fixes, asked } = rules({ remove: 'A quick fix is running. Wait for it to finish.' });
    const h = setup({ fixes });
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    await expectReviewError(
      () => h.review.deleteNote(job.id, note.id),
      409,
      'A quick fix is running. Wait for it to finish.',
    );

    expect(asked.remove).toEqual([note.id]);
    expect(h.notes.get(note.id)).not.toBeNull();
    expect(h.removesOf()).toEqual([]);
  });

  it('deletes the note when the rules let it', async () => {
    const { fixes, asked } = rules();
    const h = setup({ fixes });
    const job = h.addJob();
    const note = h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    await h.review.deleteNote(job.id, note.id);

    expect(asked.remove).toEqual([note.id]);
    expect(h.notes.get(note.id)).toBeNull();
    expect(h.removesOf()).toEqual([note.id]);
  });

  it('answers 404 when the note is gone by the time its fix is undone', async () => {
    const h = setup({
      fixes: {
        said: () => null,
        clearRound: async () => {},
        beforeEdit: () => null,
        // Undoing the fix takes a moment; meanwhile the note was deleted from another tab.
        beforeDelete: async () => {
          h.notes.remove('n1');
          return null;
        },
      },
    });
    const job = h.addJob();
    h.review.addTextNote(job.id, { atSec: 1, text: 'Typed' });

    await expectReviewError(
      () => h.review.deleteNote(job.id, 'n1'),
      404,
      noteNotFoundMessage('n1'),
    );
  });
});

// QF4 (CVP-376): notes fixed in Review end the round with the others, and the notes that wait for
// Send run at the tier they need.
describe('Send and Approve with notes fixed in Review (QF4)', () => {
  /** Auto is reading notes: the switch is on. */
  const AUTO: NoteRouting = {
    enabled: true,
    begin: (note) => note,
    forget: () => {},
    resume: () => {},
    stop: async () => {},
  };

  /** The quick fix rules, recording which jobs' fix files were cleared. */
  function quickRules(saids: Record<string, string> = {}) {
    const cleared: string[] = [];
    const fixes: NoteFixRules = {
      beforeEdit: () => null,
      beforeDelete: async () => null,
      said: (note) => saids[note.id] ?? null,
      clearRound: async (jobId) => {
        cleared.push(jobId);
      },
    };
    return { fixes, cleared };
  }

  function quickSetup(options: SetupOptions & { saids?: Record<string, string> } = {}) {
    const rules = quickRules(options.saids);
    const h = setup({ fixes: rules.fixes, routing: AUTO, ...options });
    return { h, cleared: rules.cleared };
  }

  type Tier = 'quick' | 'revise' | 'full';
  const route = (tier: Tier) => ({
    status: 'routed' as const,
    route: {
      tier,
      kind: 'Changing the caption font',
      why: tier === 'quick' ? '' : 'it changes the cut',
    },
  });

  /** A text note, sorted by Auto as `tier` (none: never read; `pending`: being read), fixed or not. */
  function add(
    h: Harness,
    job: Job,
    text: string,
    atSec: number,
    options: { tier?: Tier | 'pending'; fixed?: boolean } = {},
  ): string {
    const note = h.review.addTextNote(job.id, { atSec, text });
    if (options.tier === 'pending') h.notes.setRoute(note.id, { status: 'pending' });
    else if (options.tier !== undefined) h.notes.setRoute(note.id, route(options.tier));
    if (options.fixed === true) {
      h.notes.setFix(note.id, { fixId: `fix-${note.id}`, fixedAt: '2026-10-25T10:00:00.000Z' });
    }
    return note.id;
  }

  const roundFile = (h: Harness, job: Job, n = 1): string =>
    readFileSync(join(h.dirOf(job), `edit/review/round-${n}.md`), 'utf8');

  describe('Send', () => {
    it('lists the fixed notes as already changed after the waiting ones, stamps them all and saves the tier', async () => {
      const { h, cleared } = quickSetup({ saids: { n1: 'The title is yellow now.' } });
      const job = h.addJob(REVIEW_PATH, 'Spring menu', 'Northwind Bakery');
      add(h, job, 'make the title yellow', 12.5, { tier: 'quick', fixed: true });
      add(h, job, 'swap this shot for the drone shot', 4, { tier: 'revise' });
      add(h, job, 'the music is too loud', 30, { tier: 'revise' });

      const sent = await h.review.sendNotes(job.id);

      expect(roundFile(h, job)).toBe(
        [
          '# Review notes, round 1: Spring menu (Northwind Bakery)',
          '',
          "The owner watched the preview (edit/preview/) and wrote these notes. Each time is a moment on the preview's timeline.",
          '',
          '- 0:04.0 — swap this shot for the drone shot',
          '- 0:30.0 — the music is too loud',
          '',
          '## Already changed in Review (keep these)',
          '',
          "The owner's other notes below were already done in the live preview (edit/preview/) while they were reviewing. Keep each of them exactly as it is: do not undo, redo or move them. They are listed so you know what the preview holds.",
          '',
          '- 0:12.5 — make the title yellow',
          '  Changed: The title is yellow now.',
          '',
        ].join('\n'),
      );
      expect(sent).toMatchObject({
        state: 'queued',
        runKind: 'revise',
        round: 1,
        reviseTier: 'revise',
      });
      expect(h.jobs.get(job.id)).toEqual(sent);
      // The fixed note is stamped with the others.
      expect(h.notes.listUnsent(job.id)).toEqual([]);
      for (const id of ['n1', 'n2', 'n3']) {
        expect(h.notes.get(id)).toMatchObject({ round: 1, sentAt: h.clock().toISOString() });
      }
      expect(h.notes.get('n1')?.fixId).toBe('fix-n1');
      // In the order of their times on the timeline.
      expect(h.removesOf()).toEqual(['n2', 'n1', 'n3']);
      expect(cleared).toEqual([job.id]);
    });

    it('is the round file it always was when no note is fixed', async () => {
      const { h } = quickSetup();
      const job = h.addJob(REVIEW_PATH, 'Spring menu', 'Northwind Bakery');
      add(h, job, 'swap this shot', 4, { tier: 'revise' });

      await h.review.sendNotes(job.id);

      expect(roundFile(h, job)).toBe(
        "# Review notes, round 1: Spring menu (Northwind Bakery)\n\nThe owner watched the preview (edit/preview/) and wrote these notes. Each time is a moment on the preview's timeline.\n\n- 0:04.0 — swap this shot\n",
      );
    });

    describe('with Auto, the tier is the biggest among the waiting notes', () => {
      const cases: [string, { tier?: Tier; fixed?: boolean }[], 'revise' | 'full'][] = [
        ['one revise note', [{ tier: 'revise' }], 'revise'],
        ['one full note', [{ tier: 'full' }], 'full'],
        ['revise and full', [{ tier: 'revise' }, { tier: 'full' }], 'full'],
        ['a quick note the fix did not do counts as revise', [{ tier: 'quick' }], 'revise'],
        ['a quick note with a revise one', [{ tier: 'quick' }, { tier: 'revise' }], 'revise'],
        ['a note Auto never read counts as full', [{}], 'full'],
        ['a note never read with a revise one', [{}, { tier: 'revise' }], 'full'],
        [
          'the fixed quick note does not count, the waiting revise one does',
          [{ tier: 'quick', fixed: true }, { tier: 'revise' }],
          'revise',
        ],
        [
          'a fixed note with a bigger route is still not waiting',
          [{ tier: 'full', fixed: true }, { tier: 'revise' }],
          'revise',
        ],
      ];

      it.each(cases)('%s', async (_name, notes, expected) => {
        const { h } = quickSetup();
        const job = h.addJob();
        notes.forEach((note, i) => {
          add(h, job, `note ${i}`, i + 1, note);
        });

        const sent = await h.review.sendNotes(job.id);

        expect(sent.reviseTier).toBe(expected);
        expect(h.jobs.get(job.id)?.reviseTier).toBe(expected);
      });
    });

    it('saves no tier when a level was chosen in Review, and clears one left from an earlier round', async () => {
      const { h } = quickSetup();
      const job = h.addJob();
      h.jobs.setReviewEffort(job.id, 'high');
      h.jobs.setReviseTier(job.id, 'full');
      add(h, job, 'swap this shot', 4, { tier: 'revise' });

      const sent = await h.review.sendNotes(job.id);

      expect(sent.reviseTier).toBeNull();
      expect(sent.reviewEffort).toBe('high');
      expect(h.jobs.get(job.id)?.reviseTier).toBeNull();
    });

    it('saves no tier with the switch off, whatever the notes carry', async () => {
      const h = setup();
      const job = h.addJob();
      h.notes.setRoute(h.review.addTextNote(job.id, { atSec: 1, text: 'x' }).id, route('revise'));

      expect((await h.review.sendNotes(job.id)).reviseTier).toBeNull();
    });

    it('clears the tier an earlier Send with Auto left when the next one is not Auto', async () => {
      const h = setup();
      const job = h.addJob();
      h.jobs.setReviseTier(job.id, 'revise');
      h.review.addTextNote(job.id, { atSec: 1, text: 'x' });

      expect((await h.review.sendNotes(job.id)).reviseTier).toBeNull();
    });

    it('answers 409 when every note is already fixed, and sends nothing', async () => {
      const { h, cleared } = quickSetup();
      const job = h.addJob();
      add(h, job, 'make the title yellow', 1, { tier: 'quick', fixed: true });
      add(h, job, 'make the logo bigger', 2, { tier: 'quick', fixed: true });

      await expectReviewError(
        () => h.review.sendNotes(job.id),
        409,
        'Every note is already fixed here. Approve instead.',
      );

      expect(existsSync(join(h.dirOf(job), 'edit/review/round-1.md'))).toBe(false);
      expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0, reviseTier: null });
      expect(h.notes.listUnsent(job.id)).toHaveLength(2);
      expect(cleared).toEqual([]);
    });

    it('answers 409 while Auto is still reading a waiting note, and sends nothing', async () => {
      const { h, cleared } = quickSetup();
      const job = h.addJob();
      add(h, job, 'swap this shot', 1, { tier: 'revise' });
      add(h, job, 'make the title yellow', 2, { tier: 'pending' });

      await expectReviewError(
        () => h.review.sendNotes(job.id),
        409,
        'Wait for Auto to read the notes.',
      );

      expect(existsSync(join(h.dirOf(job), 'edit/review/round-1.md'))).toBe(false);
      expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', round: 0 });
      expect(cleared).toEqual([]);

      // Once the note is sorted, Send goes.
      h.notes.setRoute('n2', route('quick'));
      expect((await h.review.sendNotes(job.id)).reviseTier).toBe('revise');
    });

    it('does not wait for Auto when a level was chosen, or when the switch is off', async () => {
      const { h } = quickSetup();
      const job = h.addJob();
      h.jobs.setReviewEffort(job.id, 'medium');
      add(h, job, 'make the title yellow', 2, { tier: 'pending' });
      expect(await h.review.sendNotes(job.id)).toMatchObject({ state: 'queued', reviseTier: null });

      const off = setup();
      const other = off.addJob();
      off.notes.setRoute(off.review.addTextNote(other.id, { atSec: 1, text: 'x' }).id, {
        status: 'pending',
      });
      expect(await off.review.sendNotes(other.id)).toMatchObject({ state: 'queued' });
    });

    it('asks the block before the others, so a running fix answers busy', async () => {
      const { h } = quickSetup({
        reviewBlock: () => 'A quick fix is running. Wait for it to finish.',
      });
      const job = h.addJob();
      add(h, job, 'make the title yellow', 2, { tier: 'pending' });

      await expectReviewError(
        () => h.review.sendNotes(job.id),
        409,
        'A quick fix is running. Wait for it to finish.',
      );
    });

    it('runs the Add to style and Add to series hooks for the fixed notes too', async () => {
      const style = vi.fn(async (_job: Job, _notes: readonly ReviewNote[]) => {});
      const series = vi.fn(async (_job: Job, _notes: readonly ReviewNote[]) => {});
      const { h } = quickSetup({
        styleNotes: { append: style },
        seriesNotes: { enabled: true, append: series },
      });
      const job = h.addJob();
      const fixed = add(h, job, 'make the title yellow', 1, { tier: 'quick', fixed: true });
      const waiting = add(h, job, 'swap this shot', 2, { tier: 'revise' });
      h.notes.update(fixed, { addToStyle: true, addToSeries: true });
      h.notes.update(waiting, { addToStyle: true });

      await h.review.sendNotes(job.id);

      expect(style.mock.calls[0]?.[1].map((note) => note.id)).toEqual([fixed, waiting]);
      expect(series.mock.calls[0]?.[1].map((note) => note.id)).toEqual([fixed]);
      expect(style.mock.calls[0]?.[0]).toMatchObject({ round: 1 });
    });

    it('is not failed by fix files that cannot be cleared', async () => {
      const rules = quickRules();
      rules.fixes.clearRound = async () => {
        throw new Error('disk full');
      };
      const h = setup({ fixes: rules.fixes, routing: AUTO });
      const job = h.addJob();
      add(h, job, 'swap this shot', 1, { tier: 'revise' });

      expect(await h.review.sendNotes(job.id)).toMatchObject({ state: 'queued' });
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id }),
        'could not clear the quick fix files of a job',
      );
    });

    it('keeps the files out of a Send the transaction refuses', async () => {
      const { h, cleared } = quickSetup();
      const job = h.addJob();
      add(h, job, 'swap this shot', 1, { tier: 'revise' });
      vi.spyOn(h.jobs, 'applyTransition').mockImplementation(() => {
        throw new Error('boom');
      });

      await expect(h.review.sendNotes(job.id)).rejects.toThrow('boom');

      expect(h.jobs.get(job.id)?.reviseTier).toBeNull();
      expect(h.notes.listUnsent(job.id)).toHaveLength(1);
      expect(cleared).toEqual([]);
    });
  });

  describe('Approve', () => {
    it('works when every unsent note is fixed: stamps them with the next round and leaves the job’s round', async () => {
      const onSent = vi.fn((_job: Job, _notes: readonly ReviewNote[]) => {});
      const { h, cleared } = quickSetup({ onSent });
      const job = h.addJob();
      const a = add(h, job, 'make the title yellow', 1, { tier: 'quick', fixed: true });
      const b = add(h, job, 'make the logo bigger', 2, { tier: 'quick', fixed: true });

      const approved = await h.review.approve(job.id);

      expect(approved).toMatchObject({ state: 'queued', runKind: 'render', round: 0 });
      expect(approved.approvedAt).toBe(h.clock().toISOString());
      for (const id of [a, b]) {
        expect(h.notes.get(id)).toMatchObject({ round: 1, sentAt: h.clock().toISOString() });
      }
      expect(h.notes.listUnsent(job.id)).toEqual([]);
      expect(h.jobs.get(job.id)?.round).toBe(0);
      expect(h.removesOf()).toEqual([a, b]);
      expect(onSent).toHaveBeenCalledTimes(1);
      expect(onSent.mock.calls[0]?.[1].map((note) => note.id)).toEqual([a, b]);
      expect(cleared).toEqual([job.id]);
    });

    it('stamps round + 1 after an earlier round, and the job stays at its round', async () => {
      const { h } = quickSetup();
      const job = h.addJob();
      add(h, job, 'swap this shot', 1, { tier: 'revise' });
      await h.review.sendNotes(job.id);
      h.jobs.applyTransition(job.id, { type: 'START' });
      h.jobs.applyTransition(job.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
      const fixed = add(h, job, 'make the title yellow', 2, { tier: 'quick', fixed: true });

      const approved = await h.review.approve(job.id);

      expect(approved.round).toBe(1);
      expect(h.notes.get(fixed)?.round).toBe(2);
    });

    it('runs the Add to style and Add to series hooks for them as Send does, with the round they were stamped with', async () => {
      const style = vi.fn(async (_job: Job, _notes: readonly ReviewNote[]) => {});
      const series = vi.fn(async (_job: Job, _notes: readonly ReviewNote[]) => {});
      const { h } = quickSetup({
        styleNotes: { append: style },
        seriesNotes: { enabled: true, append: series },
      });
      const job = h.addJob();
      const styled = add(h, job, 'titles stay a second longer', 1, { tier: 'quick', fixed: true });
      const plain = add(h, job, 'make the logo bigger', 2, { tier: 'quick', fixed: true });
      h.notes.update(styled, { addToStyle: true, addToSeries: true });

      await h.review.approve(job.id);

      expect(style.mock.calls[0]?.[1].map((note) => note.id)).toEqual([styled]);
      expect(style.mock.calls[0]?.[0]).toMatchObject({
        id: job.id,
        state: 'queued',
        runKind: 'render',
        round: 1,
      });
      expect(series.mock.calls[0]?.[1].map((note) => note.id)).toEqual([styled]);
      expect(series.mock.calls[0]?.[0].round).toBe(1);
      expect(h.notes.get(plain)?.round).toBe(1);
      // The job itself did not move to the next round.
      expect(h.jobs.get(job.id)?.round).toBe(0);
    });

    it('answers 409 sendOrDeleteFirst while a waiting note is unsent, and leaves everything as it was', async () => {
      const { h, cleared } = quickSetup();
      const job = h.addJob();
      const fixed = add(h, job, 'make the title yellow', 1, { tier: 'quick', fixed: true });
      add(h, job, 'swap this shot', 2, { tier: 'revise' });

      await expectReviewError(
        () => h.review.approve(job.id),
        409,
        REVIEW_MESSAGES.sendOrDeleteFirst,
      );

      expect(h.jobs.get(job.id)).toMatchObject({ state: 'review', approvedAt: null });
      expect(h.notes.get(fixed)?.round).toBeNull();
      expect(h.notes.listUnsent(job.id)).toHaveLength(2);
      expect(h.removesOf()).toEqual([]);
      expect(cleared).toEqual([]);
    });

    it('still refuses a note Auto has not sorted yet, or a quick one the fix did not do', async () => {
      const { h } = quickSetup();
      const job = h.addJob();
      add(h, job, 'make the title yellow', 1, { tier: 'quick' });
      await expectReviewError(
        () => h.review.approve(job.id),
        409,
        REVIEW_MESSAGES.sendOrDeleteFirst,
      );
      const other = h.addJob(REVIEW_PATH, 'Other');
      add(h, other, 'make the title yellow', 1, { tier: 'pending' });
      await expectReviewError(
        () => h.review.approve(other.id),
        409,
        REVIEW_MESSAGES.sendOrDeleteFirst,
      );
    });

    it('with no notes at all clears the round’s files and approves as before', async () => {
      const { h, cleared } = quickSetup();
      const job = h.addJob();

      expect(await h.review.approve(job.id)).toMatchObject({ state: 'queued', runKind: 'render' });
      expect(cleared).toEqual([job.id]);
      expect(h.removesOf()).toEqual([]);
    });

    it('is not failed by fix files that cannot be cleared', async () => {
      const rules = quickRules();
      rules.fixes.clearRound = async () => {
        throw new Error('disk full');
      };
      const h = setup({ fixes: rules.fixes, routing: AUTO });
      const job = h.addJob();
      add(h, job, 'make the title yellow', 1, { tier: 'quick', fixed: true });

      expect(await h.review.approve(job.id)).toMatchObject({ state: 'queued', runKind: 'render' });
    });

    it('stamps nothing and clears nothing when the job is not in review', async () => {
      const { h, cleared } = quickSetup();
      const job = h.addJob([{ type: 'SETTLED' }]);

      await expect(h.review.approve(job.id)).rejects.toThrow(InvalidTransition);
      expect(cleared).toEqual([]);
    });

    it('waits behind a Send of the same job', async () => {
      const { h } = quickSetup();
      const job = h.addJob();
      add(h, job, 'swap this shot', 1, { tier: 'revise' });

      const send = h.review.sendNotes(job.id);
      const approve = h.review.approve(job.id);
      const refused = expect(approve).rejects.toThrow(InvalidTransition);

      await send;
      // The job left review with the Send, so the Approve is refused, not run on a half-sent job.
      await refused;
      expect(h.notes.get('n1')?.round).toBe(1);
    });
  });
});
