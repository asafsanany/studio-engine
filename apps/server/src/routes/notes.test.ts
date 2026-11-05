import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  deleteNoteResponseSchema,
  type Job,
  type JobEvent,
  jobSchema,
  noteListResponseSchema,
  noteResponseSchema,
  type ReviewNote,
  SERIES_MESSAGES,
  VOICE_NOTE_MAX_BYTES,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository, NoteRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import {
  createVoiceTranscriber,
  FAKE_VOICE_FAIL_MARKER,
  FAKE_VOICE_TEXT,
  type VoiceTranscriber,
} from '../pipeline/voice-transcriber.js';
import { createReviewService, REVIEW_MESSAGES } from '../review/review-service.js';
import type { ActionWorker } from './jobs.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real repositories on an in-memory database, the real review service on a temp inbox, the
// fake voice transcriber, `app.request` for the HTTP.

const CLIENT = 'Northwind Bakery';

const REVIEW_PATH: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];

const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 10, 11, 12, 13, 14, 15]);

const dirs: string[] = [];
const opened: StudioDb[] = [];
const transcribers: VoiceTranscriber[] = [];

afterEach(async () => {
  for (const transcriber of transcribers.splice(0)) await transcriber.stop();
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  app: Hono;
  jobs: JobRepository;
  notes: NoteRepository;
  inboxPath: string;
  /** What onJobChanged and the fake worker saw, in order. */
  log: string[];
  /** A job (default in review) with its folder on disk. */
  addJob(path?: JobEvent[], name?: string): Job;
  dirOf(job: Job): string;
}

function harness(options: { voiceMaxBytes?: number; series?: boolean } = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), 'studio-notes-routes-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const bus = createEventBus();
  const transcriber = createVoiceTranscriber({ kind: 'fake', sleep: async () => {} });
  transcribers.push(transcriber);
  let counter = 0;
  const review = createReviewService({
    db,
    jobs,
    notes,
    bus,
    inboxPath,
    transcriber,
    // Series are off unless the test turns them on.
    seriesNotes: { enabled: options.series ?? false, append: async () => {} },
    clock,
    newId: () => `n${++counter}`,
  });
  const log: string[] = [];
  const worker: ActionWorker = {
    cancel: async () => null,
    notify: () => {
      log.push('notify');
    },
  };
  const app = createApp({
    jobs: {
      jobs,
      worker,
      exportsDir: join(base, 'exports'),
      onJobChanged: (job) => {
        log.push(`changed:${job.state}`);
      },
      review,
    },
    notes: { review, voiceMaxBytes: options.voiceMaxBytes },
  });

  return {
    app,
    jobs,
    notes,
    inboxPath,
    log,
    addJob(path = REVIEW_PATH, name = 'Spring menu') {
      const { job } = jobs.upsertFromScan(makeScan(CLIENT, name));
      for (const event of path) jobs.applyTransition(job.id, event);
      mkdirSync(join(inboxPath, job.relPath), { recursive: true });
      return jobs.get(job.id) as Job;
    },
    dirOf: (job) => join(inboxPath, job.relPath),
  };
}

async function expectError(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  return apiErrorSchema.parse(await res.json()).error;
}

function jsonRequest(method: string, body?: unknown, raw?: string): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  };
}

function voiceForm(
  fields: { audio?: Blob | null; atSec?: string | null; audioSec?: string | null } = {},
): FormData {
  const form = new FormData();
  const audio =
    fields.audio === undefined ? new Blob([WEBM], { type: 'audio/webm' }) : fields.audio;
  if (audio !== null) form.append('audio', audio, 'voice.webm');
  const atSec = fields.atSec === undefined ? '7.8' : fields.atSec;
  if (atSec !== null) form.append('atSec', atSec);
  const audioSec = fields.audioSec === undefined ? '12' : fields.audioSec;
  if (audioSec !== null) form.append('audioSec', audioSec);
  return form;
}

const post = async (h: Harness, id: string, path: string, body?: unknown): Promise<Response> =>
  h.app.request(`/api/jobs/${id}/${path}`, jsonRequest('POST', body));

const postVoice = async (
  h: Harness,
  id: string,
  form: FormData | string = voiceForm(),
): Promise<Response> =>
  typeof form === 'string'
    ? h.app.request(`/api/jobs/${id}/notes/voice`, jsonRequest('POST', undefined, form))
    : h.app.request(`/api/jobs/${id}/notes/voice`, { method: 'POST', body: form });

async function addText(h: Harness, id: string, text = 'The title goes too fast.', atSec = 2.4) {
  const res = await post(h, id, 'notes', { atSec, text });
  expect(res.status).toBe(201);
  return noteResponseSchema.parse(await res.json());
}

async function addVoice(h: Harness, id: string, form: FormData = voiceForm()) {
  const res = await postVoice(h, id, form);
  expect(res.status).toBe(201);
  return noteResponseSchema.parse(await res.json());
}

async function listNotes(h: Harness, id: string): Promise<ReviewNote[]> {
  const res = await h.app.request(`/api/jobs/${id}/notes`);
  expect(res.status).toBe(200);
  return noteListResponseSchema.parse(await res.json());
}

describe('GET /api/jobs/:id/notes', () => {
  it('answers the unsent notes by atSec', async () => {
    const h = harness();
    const job = h.addJob();
    expect(await listNotes(h, job.id)).toEqual([]);
    await addText(h, job.id, 'Late', 9);
    await addText(h, job.id, 'Early', 1);

    const notes = await listNotes(h, job.id);

    expect(notes.map((note) => note.text)).toEqual(['Early', 'Late']);
  });
});

describe('POST /api/jobs/:id/notes', () => {
  it('answers 201 with the trimmed note', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await post(h, job.id, 'notes', { atSec: 2.43, text: '  הכותרת יורדת מהר מדי.  ' });

    expect(res.status).toBe(201);
    const note = noteResponseSchema.parse(await res.json());
    expect(note).toMatchObject({
      jobId: job.id,
      kind: 'text',
      atSec: 2.43,
      text: 'הכותרת יורדת מהר מדי.',
      round: null,
      transcriptStatus: null,
    });
    expect(h.notes.get(note.id)).toEqual(note);
  });

  it.each([
    ['a body that is not JSON', undefined, 'not json at all'],
    ['a missing atSec', { text: 'x' }, undefined],
    ['a string atSec', { atSec: '2', text: 'x' }, undefined],
    ['a negative atSec', { atSec: -1, text: 'x' }, undefined],
    ['a missing text', { atSec: 1 }, undefined],
    ['a text that is not a string', { atSec: 1, text: 5 }, undefined],
  ])('answers 400 noteBody for %s', async (_label, body, raw) => {
    const h = harness();
    const job = h.addJob();

    const res = await h.app.request(`/api/jobs/${job.id}/notes`, jsonRequest('POST', body, raw));

    expect(await expectError(res, 400)).toBe(REVIEW_MESSAGES.noteBody);
    expect(await listNotes(h, job.id)).toEqual([]);
  });

  it('answers 400 noteEmpty for empty text and noteTooLong for 2001 characters', async () => {
    const h = harness();
    const job = h.addJob();

    expect(await expectError(await post(h, job.id, 'notes', { atSec: 1, text: '  ' }), 400)).toBe(
      REVIEW_MESSAGES.noteEmpty,
    );
    expect(
      await expectError(await post(h, job.id, 'notes', { atSec: 1, text: 'x'.repeat(2001) }), 400),
    ).toBe(REVIEW_MESSAGES.noteTooLong);
    expect((await post(h, job.id, 'notes', { atSec: 1, text: 'x'.repeat(2000) })).status).toBe(201);
  });
});

describe('POST /api/jobs/:id/notes/voice', () => {
  it.each([
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/webm', 'webm'],
    ['audio/mp4', 'm4a'],
  ])(
    'takes a recording of type %s and answers 201 with a pending note',
    async (type, extension) => {
      const h = harness();
      const job = h.addJob();

      const res = await postVoice(
        h,
        job.id,
        voiceForm({ audio: new Blob([WEBM], { type }), atSec: '7.8', audioSec: '12.5' }),
      );

      expect(res.status).toBe(201);
      const note = noteResponseSchema.parse(await res.json());
      expect(note).toMatchObject({
        id: 'n1',
        kind: 'voice',
        atSec: 7.8,
        audioSec: 12.5,
        audioFile: `edit/review/voice/n1.${extension}`,
        transcriptStatus: 'pending',
        text: null,
      });
      expect([...readFileSync(join(h.dirOf(job), note.audioFile as string))]).toEqual([...WEBM]);
    },
  );

  it('refuses a type that is not audio/webm or audio/mp4', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await postVoice(
      h,
      job.id,
      voiceForm({ audio: new Blob([WEBM], { type: 'audio/ogg' }) }),
    );

    expect(await expectError(res, 400)).toBe(REVIEW_MESSAGES.voiceType);
    expect(await listNotes(h, job.id)).toEqual([]);
  });

  it('refuses an empty recording', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await postVoice(
      h,
      job.id,
      voiceForm({ audio: new Blob([], { type: 'audio/webm' }) }),
    );

    expect(await expectError(res, 400)).toBe(REVIEW_MESSAGES.voiceEmpty);
  });

  it.each([
    ['no audio field', () => voiceForm({ audio: null })],
    ['an empty atSec', () => voiceForm({ atSec: '' })],
    ['an atSec that is not a number', () => voiceForm({ atSec: 'abc' })],
    ['a negative atSec', () => voiceForm({ atSec: '-1' })],
    ['no audioSec', () => voiceForm({ audioSec: null })],
    ['an audioSec of 0', () => voiceForm({ audioSec: '0' })],
    [
      'an audio field that is text',
      () => {
        const form = new FormData();
        form.append('audio', 'not a file');
        form.append('atSec', '1');
        form.append('audioSec', '1');
        return form;
      },
    ],
  ])('answers 400 voiceForm for %s', async (_label, build) => {
    const h = harness();
    const job = h.addJob();

    expect(await expectError(await postVoice(h, job.id, build()), 400)).toBe(
      REVIEW_MESSAGES.voiceForm,
    );
  });

  it('answers 400 voiceForm for a JSON body', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await postVoice(h, job.id, JSON.stringify({ atSec: 1, audioSec: 1 }));

    expect(await expectError(res, 400)).toBe(REVIEW_MESSAGES.voiceForm);
  });

  it('refuses more than 5 minutes (one second of slack)', async () => {
    const h = harness();
    const job = h.addJob();

    expect(
      await expectError(await postVoice(h, job.id, voiceForm({ audioSec: '301.5' })), 400),
    ).toBe(REVIEW_MESSAGES.voiceTooLong);
    expect((await postVoice(h, job.id, voiceForm({ audioSec: '301' }))).status).toBe(201);
  });

  it('answers 413 for a recording over the limit, and keeps no file and no note', async () => {
    const h = harness({ voiceMaxBytes: 1024 });
    const job = h.addJob();

    const res = await postVoice(
      h,
      job.id,
      voiceForm({ audio: new Blob([new Uint8Array(2048)], { type: 'audio/webm' }) }),
    );

    expect(await expectError(res, 413)).toBe(REVIEW_MESSAGES.voiceTooLarge);
    expect(await listNotes(h, job.id)).toEqual([]);
    expect(existsSync(join(h.dirOf(job), 'edit/review/voice'))).toBe(false);
  });

  it('answers 413 for a whole body far over the limit, before anything else', async () => {
    const h = harness({ voiceMaxBytes: 1024 });
    const job = h.addJob();

    const res = await postVoice(
      h,
      job.id,
      voiceForm({ audio: new Blob([new Uint8Array(200 * 1024)], { type: 'audio/webm' }) }),
    );

    expect(await expectError(res, 413)).toBe(REVIEW_MESSAGES.voiceTooLarge);
    expect(await listNotes(h, job.id)).toEqual([]);
  });

  it('limits to 25 MB by default', async () => {
    const h = harness();
    const job = h.addJob();

    const tooBig = await postVoice(
      h,
      job.id,
      voiceForm({
        audio: new Blob([new Uint8Array(VOICE_NOTE_MAX_BYTES + 100 * 1024)], {
          type: 'audio/webm',
        }),
      }),
    );
    const fine = await postVoice(
      h,
      job.id,
      voiceForm({ audio: new Blob([new Uint8Array(1024 * 1024)], { type: 'audio/webm' }) }),
    );

    expect(await expectError(tooBig, 413)).toBe(REVIEW_MESSAGES.voiceTooLarge);
    expect(fine.status).toBe(201);
  });

  it('is transcribed by the fake transcriber, and the note comes back done', async () => {
    const h = harness();
    const job = h.addJob();
    const note = await addVoice(h, job.id);
    expect(note.transcriptStatus).toBe('pending');

    await vi.waitFor(async () => {
      expect(await listNotes(h, job.id)).toEqual([
        expect.objectContaining({ id: note.id, transcriptStatus: 'done', text: FAKE_VOICE_TEXT }),
      ]);
    });
  });

  it('becomes failed when the fake transcription fails', async () => {
    const h = harness();
    const job = h.addJob();
    mkdirSync(join(h.dirOf(job), 'edit/review/voice'), { recursive: true });
    writeFileSync(join(h.dirOf(job), 'edit/review/voice', FAKE_VOICE_FAIL_MARKER), '');
    const note = await addVoice(h, job.id);

    await vi.waitFor(async () => {
      expect(await listNotes(h, job.id)).toEqual([
        expect.objectContaining({ id: note.id, transcriptStatus: 'failed', text: null }),
      ]);
    });
  });
});

describe('PATCH /api/jobs/:id/notes/:noteId', () => {
  it('changes the text and Add to style', async () => {
    const h = harness();
    const job = h.addJob();
    const note = await addText(h, job.id);

    const edited = await h.app.request(
      `/api/jobs/${job.id}/notes/${note.id}`,
      jsonRequest('PATCH', { text: '  Slower, please.  ' }),
    );
    const styled = await h.app.request(
      `/api/jobs/${job.id}/notes/${note.id}`,
      jsonRequest('PATCH', { addToStyle: true }),
    );

    expect(edited.status).toBe(200);
    expect(noteResponseSchema.parse(await edited.json())).toMatchObject({
      text: 'Slower, please.',
    });
    expect(styled.status).toBe(200);
    expect(noteResponseSchema.parse(await styled.json())).toMatchObject({
      text: 'Slower, please.',
      addToStyle: true,
    });
  });

  describe('addToSeries', () => {
    const EPISODE = { seriesId: '622212180eef', episode: 6, pinned: false };
    const patch = (h: Harness, jobId: string, noteId: string, body: unknown) =>
      h.app.request(`/api/jobs/${jobId}/notes/${noteId}`, jsonRequest('PATCH', body));

    it('is saved on an episode while series are on', async () => {
      const h = harness({ series: true });
      const job = h.addJob();
      h.jobs.setSeries(job.id, EPISODE);
      const note = await addText(h, job.id);

      const marked = await patch(h, job.id, note.id, { addToSeries: true });
      const both = await patch(h, job.id, note.id, { addToStyle: true });
      const unmarked = await patch(h, job.id, note.id, { addToSeries: false });

      expect(marked.status).toBe(200);
      expect(noteResponseSchema.parse(await marked.json())).toMatchObject({
        addToSeries: true,
        addToStyle: false,
      });
      expect(noteResponseSchema.parse(await both.json())).toMatchObject({
        addToSeries: true,
        addToStyle: true,
      });
      expect(noteResponseSchema.parse(await unmarked.json())).toMatchObject({
        addToSeries: false,
        addToStyle: true,
      });
      expect(h.notes.get(note.id)?.addToSeries).toBe(false);
    });

    it('answers 422 for a job in no series, and saves nothing', async () => {
      const h = harness({ series: true });
      const job = h.addJob();
      const note = await addText(h, job.id);

      const res = await patch(h, job.id, note.id, { addToSeries: true, addToStyle: true });

      expect(await expectError(res, 422)).toBe(REVIEW_MESSAGES.notInSeries);
      expect(h.notes.get(note.id)).toMatchObject({ addToSeries: false, addToStyle: false });
    });

    it('answers 422 "Series are off." on any job while series are off, an episode too', async () => {
      const h = harness();
      const plain = h.addJob();
      const episode = h.addJob(REVIEW_PATH, 'Spring menu 6');
      h.jobs.setSeries(episode.id, EPISODE);
      const plainNote = await addText(h, plain.id);
      const episodeNote = await addText(h, episode.id);

      const onPlain = await patch(h, plain.id, plainNote.id, { addToSeries: true });
      const onEpisode = await patch(h, episode.id, episodeNote.id, { addToSeries: true });

      expect(await expectError(onPlain, 422)).toBe(SERIES_MESSAGES.off);
      expect(await expectError(onEpisode, 422)).toBe(SERIES_MESSAGES.off);
      expect(h.notes.get(episodeNote.id)?.addToSeries).toBe(false);
    });

    it('never refuses false: a mark that can’t be kept can be cleared', async () => {
      const h = harness();
      const job = h.addJob();
      const note = await addText(h, job.id);
      h.notes.update(note.id, { addToSeries: true });

      const res = await patch(h, job.id, note.id, { addToSeries: false });

      expect(res.status).toBe(200);
      expect(noteResponseSchema.parse(await res.json()).addToSeries).toBe(false);
    });

    it('is checked after the job and the note: 404 for an unknown note, 409 outside Review', async () => {
      const h = harness();
      const job = h.addJob();
      const ready = h.addJob([...REVIEW_PATH, { type: 'SEND_NOTES' }], 'Spring menu 7');

      expect(await expectError(await patch(h, job.id, 'nope', { addToSeries: true }), 404)).toBe(
        'Note nope not found',
      );
      expect(await expectError(await patch(h, ready.id, 'n1', { addToSeries: true }), 409)).toBe(
        REVIEW_MESSAGES.notInReview,
      );
    });
  });

  it.each([
    ['an empty object', {}, undefined],
    ['a non-boolean addToStyle', { addToStyle: 'yes' }, undefined],
    ['a body that is not JSON', undefined, '{oops'],
  ])('answers 400 patchBody for %s', async (_label, body, raw) => {
    const h = harness();
    const job = h.addJob();
    const note = await addText(h, job.id);

    const res = await h.app.request(
      `/api/jobs/${job.id}/notes/${note.id}`,
      jsonRequest('PATCH', body, raw),
    );

    expect(await expectError(res, 400)).toBe(REVIEW_MESSAGES.patchBody);
  });

  it('answers 400 voiceTextFixed for the text of a voice note', async () => {
    const h = harness();
    const job = h.addJob();
    const note = await addVoice(h, job.id);

    const res = await h.app.request(
      `/api/jobs/${job.id}/notes/${note.id}`,
      jsonRequest('PATCH', { text: 'Mine' }),
    );

    expect(await expectError(res, 400)).toBe(REVIEW_MESSAGES.voiceTextFixed);
  });
});

describe('DELETE /api/jobs/:id/notes/:noteId', () => {
  it('answers { ok: true } and removes the note and its recording', async () => {
    const h = harness();
    const job = h.addJob();
    const note = await addVoice(h, job.id);
    const typed = await addText(h, job.id);

    const res = await h.app.request(`/api/jobs/${job.id}/notes/${note.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(deleteNoteResponseSchema.parse(await res.json())).toEqual({ ok: true });
    expect(existsSync(join(h.dirOf(job), note.audioFile as string))).toBe(false);
    expect((await listNotes(h, job.id)).map((entry) => entry.id)).toEqual([typed.id]);
  });
});

describe('GET /api/jobs/:id/notes/:noteId/audio', () => {
  it('serves the recording inline with its type, and byte ranges', async () => {
    const h = harness();
    const job = h.addJob();
    const webm = await addVoice(h, job.id);
    const m4a = await addVoice(
      h,
      job.id,
      voiceForm({ audio: new Blob([WEBM], { type: 'audio/mp4' }) }),
    );

    const whole = await h.app.request(`/api/jobs/${job.id}/notes/${webm.id}/audio`);
    const mp4 = await h.app.request(`/api/jobs/${job.id}/notes/${m4a.id}/audio`);
    const part = await h.app.request(`/api/jobs/${job.id}/notes/${webm.id}/audio`, {
      headers: { Range: 'bytes=0-3' },
    });
    const head = await h.app.request(`/api/jobs/${job.id}/notes/${webm.id}/audio`, {
      method: 'HEAD',
    });

    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/webm');
    expect(whole.headers.get('content-disposition')).toBe('inline');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual([...WEBM]);
    expect(mp4.status).toBe(200);
    expect(mp4.headers.get('content-type')).toBe('audio/mp4');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-3/${WEBM.length}`);
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...WEBM.slice(0, 4)]);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(WEBM.length));
  });

  it('answers 404 noAudio for a text note, and audioMissing after the file was removed', async () => {
    const h = harness();
    const job = h.addJob();
    const typed = await addText(h, job.id);
    const voice = await addVoice(h, job.id);
    rmSync(join(h.dirOf(job), voice.audioFile as string));

    expect(
      await expectError(await h.app.request(`/api/jobs/${job.id}/notes/${typed.id}/audio`), 404),
    ).toBe(REVIEW_MESSAGES.noAudio);
    expect(
      await expectError(await h.app.request(`/api/jobs/${job.id}/notes/${voice.id}/audio`), 404),
    ).toBe(REVIEW_MESSAGES.audioMissing);
  });
});

describe('errors that every route shares', () => {
  const NOT_IN_REVIEW = REVIEW_MESSAGES.notInReview;

  /** The six routes, as a request for a job id and a note id. */
  const routes: Array<[string, (h: Harness, id: string, noteId: string) => Promise<Response>]> = [
    ['GET notes', (h, id) => Promise.resolve(h.app.request(`/api/jobs/${id}/notes`))],
    ['POST notes', (h, id) => post(h, id, 'notes', { atSec: 1, text: 'x' })],
    ['POST notes/voice', (h, id) => postVoice(h, id)],
    [
      'PATCH note',
      (h, id, noteId) =>
        Promise.resolve(
          h.app.request(
            `/api/jobs/${id}/notes/${noteId}`,
            jsonRequest('PATCH', { addToStyle: true }),
          ),
        ),
    ],
    [
      'DELETE note',
      (h, id, noteId) =>
        Promise.resolve(h.app.request(`/api/jobs/${id}/notes/${noteId}`, { method: 'DELETE' })),
    ],
    [
      'GET audio',
      (h, id, noteId) => Promise.resolve(h.app.request(`/api/jobs/${id}/notes/${noteId}/audio`)),
    ],
  ];

  it.each(routes)('%s answers 409 for a job that is queued', async (_label, call) => {
    const h = harness();
    const job = h.addJob([{ type: 'SETTLED' }]);

    expect(await expectError(await call(h, job.id, 'n1'), 409)).toBe(NOT_IN_REVIEW);
  });

  it.each(routes)('%s answers 404 for an unknown job', async (_label, call) => {
    const h = harness();

    expect(await expectError(await call(h, 'nobody', 'n1'), 404)).toBe('Job nobody not found');
  });

  it('answers 404 for an unknown note on PATCH, DELETE and audio', async () => {
    const h = harness();
    const job = h.addJob();

    for (const [label, call] of routes.slice(3)) {
      expect(await expectError(await call(h, job.id, 'n9'), 404), label).toBe('Note n9 not found');
    }
  });

  it('answers 404 for a note that was sent already', async () => {
    const h = harness();
    const job = h.addJob();
    const other = h.addJob(REVIEW_PATH, 'Summer menu');
    h.notes.create({ id: 'sent', jobId: job.id, kind: 'text', atSec: 1, text: 'Sent' });
    h.notes.markSent(job.id, ['sent'], 1, '2026-10-20T10:30:00.000Z');
    h.notes.create({ id: 'theirs', jobId: other.id, kind: 'text', atSec: 1, text: 'Theirs' });

    for (const noteId of ['sent', 'theirs']) {
      for (const [label, call] of routes.slice(3, 5)) {
        expect(await expectError(await call(h, job.id, noteId), 404), label).toBe(
          `Note ${noteId} not found`,
        );
      }
    }
  });
});

describe('POST send-notes and approve', () => {
  it('send-notes answers 409 noNotesToSend without a note', async () => {
    const h = harness();
    const job = h.addJob();

    expect(await expectError(await post(h, job.id, 'send-notes'), 409)).toBe(
      REVIEW_MESSAGES.noNotesToSend,
    );
    expect(h.log).toEqual([]);
  });

  it('send-notes answers 409 waitForTranscripts while a voice note is pending', async () => {
    const h = harness();
    const job = h.addJob();
    await addVoice(h, job.id);

    expect(await expectError(await post(h, job.id, 'send-notes'), 409)).toBe(
      REVIEW_MESSAGES.waitForTranscripts,
    );
    expect(h.log).toEqual([]);
  });

  it('send-notes answers the queued job: the round file is written, the notes are sent', async () => {
    const h = harness();
    const job = h.addJob();
    await addText(h, job.id, 'Slower title', 2.4);

    const res = await post(h, job.id, 'send-notes');

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json())).toMatchObject({
      id: job.id,
      state: 'queued',
      runKind: 'revise',
      round: 1,
    });
    expect(readFileSync(join(h.dirOf(job), 'edit/review/round-1.md'), 'utf8')).toContain(
      '- 0:02.4 — Slower title',
    );
    expect((await h.app.request(`/api/jobs/${job.id}/notes`)).status).toBe(409);
    expect(h.notes.listUnsent(job.id)).toEqual([]);
    // Published once, then the worker is woken.
    expect(h.log).toEqual(['changed:queued', 'notify']);
  });

  it("send-notes keeps W1's text for a job that is not in review", async () => {
    const h = harness();
    const job = h.addJob([{ type: 'SETTLED' }]);

    expect(await expectError(await post(h, job.id, 'send-notes'), 409)).toBe(
      'Cannot send the notes of a job that is queued.',
    );
  });

  it('approve answers 409 sendOrDeleteFirst while a note is unsent', async () => {
    const h = harness();
    const job = h.addJob();
    await addText(h, job.id);

    expect(await expectError(await post(h, job.id, 'approve'), 409)).toBe(
      REVIEW_MESSAGES.sendOrDeleteFirst,
    );
    expect(h.jobs.get(job.id)?.state).toBe('review');
    expect(h.log).toEqual([]);
  });

  it('approve answers the queued render job when no note is unsent, and wakes the worker once', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await post(h, job.id, 'approve');

    expect(res.status).toBe(200);
    expect(jobSchema.parse(await res.json())).toMatchObject({
      state: 'queued',
      runKind: 'render',
    });
    expect(h.log).toEqual(['changed:queued', 'notify']);
  });

  it("approve keeps W1's text for a job that is not in review", async () => {
    const h = harness();
    const job = h.addJob([{ type: 'SETTLED' }]);

    expect(await expectError(await post(h, job.id, 'approve'), 409)).toBe(
      'Cannot approve a job that is queued.',
    );
  });

  it('answers 404 for an unknown job', async () => {
    const h = harness();

    expect(await expectError(await post(h, 'nobody', 'send-notes'), 404)).toBe(
      'Job nobody not found',
    );
    expect(await expectError(await post(h, 'nobody', 'approve'), 404)).toBe('Job nobody not found');
  });

  it('POST /send_notes (underscore) stays the JSON 404', async () => {
    const h = harness();
    const job = h.addJob();

    expect(await expectError(await post(h, job.id, 'send_notes'), 404)).toBe('Not found');
  });
});

describe('notes and formats (Generated videos)', () => {
  const TWO = ['1080x1920', '1080x1080'];

  it('stores the format a typed note is written on and answers it', async () => {
    const h = harness();
    const job = h.addJob();
    h.jobs.setFormats(job.id, TWO);

    const res = await post(h, job.id, 'notes', { atSec: 32, text: 'Logo bigger.', format: '1x1' });
    expect(res.status).toBe(201);
    expect(noteResponseSchema.parse(await res.json()).format).toBe('1x1');
    const main = await post(h, job.id, 'notes', { atSec: 7, text: 'Stress it.' });
    expect(noteResponseSchema.parse(await main.json()).format ?? null).toBeNull();

    expect((await listNotes(h, job.id)).map((note) => note.format ?? null)).toEqual([null, '1x1']);
  });

  it('answers 400 for a format that is not an id, or one the job does not have', async () => {
    const h = harness();
    const job = h.addJob();
    h.jobs.setFormats(job.id, TWO);

    const odd = await post(h, job.id, 'notes', { atSec: 1, text: 'Hi.', format: '1:1' });
    expect(await expectError(odd, 400)).toBe(REVIEW_MESSAGES.noteBody);
    const unknown = await post(h, job.id, 'notes', { atSec: 1, text: 'Hi.', format: '4x5' });
    expect(await expectError(unknown, 400)).toBe(REVIEW_MESSAGES.badFormat);
    expect(await listNotes(h, job.id)).toEqual([]);
  });

  it('takes the format of a voice note from the form', async () => {
    const h = harness();
    const job = h.addJob();
    h.jobs.setFormats(job.id, TWO);
    const form = voiceForm();
    form.append('format', '1x1');

    expect((await addVoice(h, job.id, form)).format).toBe('1x1');
    expect((await addVoice(h, job.id)).format ?? null).toBeNull();
  });

  it('keeps a job with one format as it was: the format is dropped', async () => {
    const h = harness();
    const job = h.addJob();

    const res = await post(h, job.id, 'notes', { atSec: 1, text: 'Hi.', format: '1x1' });
    expect(res.status).toBe(201);
    expect(noteResponseSchema.parse(await res.json()).format ?? null).toBeNull();
  });
});
