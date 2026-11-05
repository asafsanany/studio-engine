import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, JobEvent, ReviewNote } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRepository, NoteRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { createReviewService, REVIEW_MESSAGES, ReviewError } from './review-service.js';

// Notes carry the format they were written on (Generated videos, GN8): a note on an extra format
// stores its id, the main format is null, and the round file of a job with two formats says which
// preview each note was written on. A job with one format is what it always was.

const dirs: string[] = [];
const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REVIEW_PATH: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];

const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'studio-review-formats-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const bus = createEventBus();
  const upserts: ReviewNote[] = [];
  bus.subscribe((event) => {
    if (event.type === 'note.upsert') upserts.push(event.note);
  });
  let counter = 0;
  const review = createReviewService({
    db,
    jobs,
    notes,
    bus,
    inboxPath,
    transcriber: { enqueue: () => new Promise(() => {}) },
    clock,
    newId: () => `n${++counter}`,
  });
  function addJob(canvases: string[] | null): Job {
    const { job } = jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad'));
    for (const event of REVIEW_PATH) jobs.applyTransition(job.id, event);
    if (canvases !== null) jobs.setFormats(job.id, canvases);
    mkdirSync(join(inboxPath, job.relPath), { recursive: true });
    return jobs.get(job.id) as Job;
  }
  const roundFile = (job: Job, n = 1): string =>
    readFileSync(join(inboxPath, job.relPath, `edit/review/round-${n}.md`), 'utf8');
  return { review, notes, jobs, upserts, addJob, roundFile };
}

const TWO = ['1080x1920', '1080x1080'];

describe('a note on a job with two formats', () => {
  it('stores the id of an extra format and null for the main one', () => {
    const h = setup();
    const job = h.addJob(TWO);

    const square = h.review.addTextNote(job.id, { atSec: 32, text: 'Logo bigger.', format: '1x1' });
    const main = h.review.addTextNote(job.id, {
      atSec: 7,
      text: 'Stress the BUT.',
      format: '9x16',
    });
    const plain = h.review.addTextNote(job.id, { atSec: 8, text: 'No format given.' });

    expect(square.format).toBe('1x1');
    expect(main.format).toBeNull();
    expect(plain.format).toBeNull();
    expect(h.notes.get(square.id)?.format).toBe('1x1');
    expect(h.upserts.find((note) => note.id === square.id)?.format).toBe('1x1');
    expect(h.review.listNotes(job.id).map((note) => note.format ?? null)).toEqual([
      null,
      null,
      '1x1',
    ]);
  });

  it('refuses a format the job does not have', () => {
    const h = setup();
    const job = h.addJob(TWO);
    expect(() => h.review.addTextNote(job.id, { atSec: 1, text: 'Hi.', format: '4x5' })).toThrow(
      new ReviewError(400, REVIEW_MESSAGES.badFormat),
    );
    expect(h.notes.listUnsent(job.id)).toEqual([]);
  });

  it('stores the format of a voice note too', async () => {
    const h = setup();
    const job = h.addJob(TWO);
    const note = await h.review.addVoiceNote(job.id, {
      audio: WEBM,
      type: 'audio/webm',
      atSec: 3,
      audioSec: 5,
      format: '1x1',
    });
    expect(note).toMatchObject({ kind: 'voice', format: '1x1' });
  });

  it('prints the format after the time in the round file, the main one too', async () => {
    const h = setup();
    const job = h.addJob(TWO);
    h.review.addTextNote(job.id, { atSec: 7, text: 'Stress the BUT more.' });
    h.review.addTextNote(job.id, { atSec: 32, text: 'End card: logo bigger.', format: '1x1' });

    await h.review.sendNotes(job.id);

    const file = h.roundFile(job);
    expect(file).toContain('- 0:07.0 (on 9:16) — Stress the BUT more.');
    expect(file).toContain('- 0:32.0 (on 1:1) — End card: logo bigger.');
  });
});

describe('a note on a job with one format', () => {
  it('stores no format, even when the page sends one, and the round file is as it was', async () => {
    const h = setup();
    const job = h.addJob(null);

    const note = h.review.addTextNote(job.id, { atSec: 2, text: 'Title faster.', format: '1x1' });
    expect(note.format).toBeNull();

    await h.review.sendNotes(job.id);
    expect(h.roundFile(job)).not.toContain('(on ');
  });

  it('is the same for a job whose brief named one size', async () => {
    const h = setup();
    const job = h.addJob(['1080x1920']);
    h.review.addTextNote(job.id, { atSec: 2, text: 'Title faster.' });
    await h.review.sendNotes(job.id);
    expect(h.roundFile(job)).toContain('- 0:02.0 — Title faster.');
  });
});
