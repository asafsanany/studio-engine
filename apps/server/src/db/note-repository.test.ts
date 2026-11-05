import { reviewNoteSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { NoteRepository } from './note-repository.js';
import { fakeClock, makeScan, memoryDb, rawRow, T0 } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  const jobA = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu')).job.id;
  const jobB = jobs.upsertFromScan(makeScan('Northwind Bakery', 'Summer menu')).job.id;
  return { clock, db, jobs, notes, jobA, jobB };
}

const SENT_AT = '2026-10-20T10:30:00.000Z';

describe('NoteRepository.create', () => {
  it('stores a text note: unsent, no audio, no transcript status, createdAt from the clock', () => {
    const { notes, jobA, clock } = setup();
    clock.tick(5_000);

    const note = notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 2.4, text: 'Slower.' });

    expect(note).toEqual({
      id: 'n1',
      jobId: jobA,
      round: null,
      atSec: 2.4,
      kind: 'text',
      text: 'Slower.',
      audioFile: null,
      audioSec: null,
      transcriptStatus: null,
      addToStyle: false,
      addToSeries: false,
      createdAt: '2026-10-20T10:00:05.000Z',
      sentAt: null,
      routeStatus: null,
      route: null,
      format: null,
      fixId: null,
      fixedAt: null,
    });
    expect(reviewNoteSchema.parse(note)).toEqual(note);
    expect(notes.get('n1')).toEqual(note);
  });

  it("stores the format of a note: an extra format's id, null for the main one (GN8)", () => {
    const { notes, jobA } = setup();

    const square = notes.create({
      id: 'n1',
      jobId: jobA,
      kind: 'text',
      atSec: 5,
      text: 'Logo bigger.',
      format: '1x1',
    });
    const voice = notes.create({
      id: 'n2',
      jobId: jobA,
      kind: 'voice',
      atSec: 6,
      audioFile: 'edit/review/voice/n2.webm',
      audioSec: 3,
      format: '1x1',
    });
    const main = notes.create({ id: 'n3', jobId: jobA, kind: 'text', atSec: 7, text: 'Hi.' });

    expect([square.format, voice.format, main.format]).toEqual(['1x1', '1x1', null]);
    expect(notes.get('n1')?.format).toBe('1x1');
    expect(notes.listUnsent(jobA).map((note) => note.format)).toEqual(['1x1', '1x1', null]);
    // Sending keeps it.
    notes.markSent(jobA, ['n1'], 1, SENT_AT);
    expect(notes.listSent(jobA).map((note) => note.format)).toEqual(['1x1']);
  });

  it('stores a voice note: pending, no text yet', () => {
    const { notes, jobA } = setup();

    const note = notes.create({
      id: 'n2',
      jobId: jobA,
      kind: 'voice',
      atSec: 7.8,
      audioFile: 'edit/review/voice/n2.webm',
      audioSec: 12.5,
    });

    expect(note).toMatchObject({
      kind: 'voice',
      text: null,
      audioFile: 'edit/review/voice/n2.webm',
      audioSec: 12.5,
      transcriptStatus: 'pending',
      addToStyle: false,
      round: null,
      sentAt: null,
      createdAt: T0,
    });
    expect(reviewNoteSchema.safeParse(note).success).toBe(true);
  });

  it('round-trips Hebrew text exactly', () => {
    const { notes, jobA } = setup();
    const text = 'הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.';

    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text });

    expect(notes.get('n1')?.text).toBe(text);
  });

  it('refuses a second note with the same id', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'One' });

    expect(() =>
      notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 2, text: 'Two' }),
    ).toThrow();
    expect(notes.get('n1')?.text).toBe('One');
  });

  it('stores add_to_style as 0/1 and the times as integer milliseconds', () => {
    const { notes, db, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'One' });
    notes.update('n1', { addToStyle: true });
    notes.markSent(jobA, ['n1'], 1, SENT_AT);

    expect(rawRow(db, 'review_notes')).toEqual([
      {
        id: 'n1',
        job_id: jobA,
        round: 1,
        at_sec: 1,
        kind: 'text',
        text: 'One',
        audio_file: null,
        audio_sec: null,
        transcript_status: null,
        add_to_style: 1,
        add_to_series: 0,
        created_at: Date.parse(T0),
        sent_at: Date.parse(SENT_AT),
        route_status: null,
        route_tier: null,
        route_kind: null,
        route_why: null,
        format: null,
        fix_id: null,
        fixed_at: null,
      },
    ]);
  });
});

describe('NoteRepository.get', () => {
  it('is null for an unknown id and finds a sent note of any job', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'One' });
    notes.markSent(jobA, ['n1'], 1, SENT_AT);

    expect(notes.get('nope')).toBeNull();
    expect(notes.get('n1')).toMatchObject({ round: 1, sentAt: SENT_AT });
  });
});

describe('NoteRepository.listUnsent and countUnsent', () => {
  it('lists the job notes by atSec, then createdAt, then id', () => {
    const { notes, jobA, clock } = setup();
    notes.create({ id: 'late', jobId: jobA, kind: 'text', atSec: 9, text: 'Late' });
    clock.tick();
    notes.create({ id: 'b-second', jobId: jobA, kind: 'text', atSec: 3, text: 'Second' });
    notes.create({ id: 'a-second', jobId: jobA, kind: 'text', atSec: 3, text: 'Also second' });
    clock.tick();
    notes.create({ id: 'zero', jobId: jobA, kind: 'text', atSec: 3, text: 'Third' });
    notes.create({ id: 'first', jobId: jobA, kind: 'text', atSec: 0, text: 'First' });

    expect(notes.listUnsent(jobA).map((note) => note.id)).toEqual([
      'first',
      // Same atSec and createdAt: the id decides.
      'a-second',
      'b-second',
      'zero',
      'late',
    ]);
  });

  it('only lists the unsent notes of that job', () => {
    const { notes, jobA, jobB } = setup();
    notes.create({ id: 'a1', jobId: jobA, kind: 'text', atSec: 1, text: 'A1' });
    notes.create({ id: 'a2', jobId: jobA, kind: 'text', atSec: 2, text: 'A2' });
    notes.create({ id: 'b1', jobId: jobB, kind: 'text', atSec: 1, text: 'B1' });
    notes.markSent(jobA, ['a1'], 1, SENT_AT);

    expect(notes.listUnsent(jobA).map((note) => note.id)).toEqual(['a2']);
    expect(notes.listUnsent(jobB).map((note) => note.id)).toEqual(['b1']);
    expect(notes.listUnsent('nobody')).toEqual([]);
  });

  it('counts the unsent notes of the job', () => {
    const { notes, jobA, jobB } = setup();
    expect(notes.countUnsent(jobA)).toBe(0);
    notes.create({ id: 'a1', jobId: jobA, kind: 'text', atSec: 1, text: 'A1' });
    notes.create({ id: 'a2', jobId: jobA, kind: 'text', atSec: 2, text: 'A2' });
    notes.create({ id: 'b1', jobId: jobB, kind: 'text', atSec: 1, text: 'B1' });
    notes.markSent(jobA, ['a1'], 1, SENT_AT);

    expect(notes.countUnsent(jobA)).toBe(1);
    expect(notes.countUnsent(jobB)).toBe(1);
  });
});

describe('NoteRepository.listSent', () => {
  it('lists the sent notes by round, then atSec, then createdAt, then id; drafts are left out', () => {
    const { notes, jobA, clock } = setup();
    notes.create({ id: 'r1-late', jobId: jobA, kind: 'text', atSec: 9, text: 'Late' });
    notes.create({ id: 'r1-early', jobId: jobA, kind: 'text', atSec: 1, text: 'Early' });
    notes.markSent(jobA, ['r1-late', 'r1-early'], 1, SENT_AT);
    clock.tick();
    // Pinned earlier than round 1's notes, but sent in round 2: it comes after them.
    notes.create({ id: 'r2-b', jobId: jobA, kind: 'text', atSec: 0.5, text: 'Round 2' });
    notes.create({ id: 'r2-a', jobId: jobA, kind: 'text', atSec: 0.5, text: 'Also round 2' });
    notes.markSent(jobA, ['r2-b', 'r2-a'], 2, SENT_AT);
    notes.create({ id: 'draft', jobId: jobA, kind: 'text', atSec: 0, text: 'Not sent yet' });

    const sent = notes.listSent(jobA);

    expect(sent.map((note) => [note.round, note.id])).toEqual([
      [1, 'r1-early'],
      [1, 'r1-late'],
      // Same round, atSec and createdAt: the id decides.
      [2, 'r2-a'],
      [2, 'r2-b'],
    ]);
    expect(sent.every((note) => note.sentAt === SENT_AT)).toBe(true);
    expect(sent.map((note) => reviewNoteSchema.parse(note))).toEqual(sent);
  });

  it('only lists the sent notes of that job, and nothing for a job that sent none or is unknown', () => {
    const { notes, jobA, jobB } = setup();
    notes.create({ id: 'a1', jobId: jobA, kind: 'text', atSec: 1, text: 'A1' });
    notes.create({ id: 'b1', jobId: jobB, kind: 'text', atSec: 1, text: 'B1' });
    notes.markSent(jobA, ['a1'], 1, SENT_AT);

    expect(notes.listSent(jobA).map((note) => note.id)).toEqual(['a1']);
    expect(notes.listSent(jobB)).toEqual([]);
    expect(notes.listSent('nobody')).toEqual([]);
  });

  it('keeps a voice note whole: its recording, length, transcript and Add to style', () => {
    const { notes, jobA } = setup();
    notes.create({
      id: 'v1',
      jobId: jobA,
      kind: 'voice',
      atSec: 7.8,
      audioFile: 'edit/review/voice/v1.webm',
      audioSec: 12.5,
    });
    notes.setTranscript('v1', { status: 'done', text: 'Cut the pause.' });
    notes.update('v1', { addToStyle: true });
    notes.markSent(jobA, ['v1'], 1, SENT_AT);

    expect(notes.listSent(jobA)).toEqual([
      expect.objectContaining({
        id: 'v1',
        round: 1,
        kind: 'voice',
        audioFile: 'edit/review/voice/v1.webm',
        audioSec: 12.5,
        text: 'Cut the pause.',
        transcriptStatus: 'done',
        addToStyle: true,
      }),
    ]);
  });
});

describe('NoteRepository.listPendingVoice', () => {
  it('lists the unsent pending voice notes of every job, oldest first', () => {
    const { notes, jobA, jobB, clock } = setup();
    const voice = (id: string, jobId: string) =>
      notes.create({
        id,
        jobId,
        kind: 'voice',
        atSec: 1,
        audioFile: `edit/review/voice/${id}.webm`,
        audioSec: 3,
      });
    voice('b-old', jobB);
    clock.tick();
    voice('a-mid', jobA);
    clock.tick();
    voice('done', jobA);
    voice('failed', jobA);
    voice('sent', jobA);
    clock.tick();
    voice('a-new', jobA);
    notes.create({ id: 'text', jobId: jobA, kind: 'text', atSec: 1, text: 'Typed' });
    notes.setTranscript('done', { status: 'done', text: 'Words' });
    notes.setTranscript('failed', { status: 'failed' });
    notes.setTranscript('sent', { status: 'done', text: 'Words' });
    notes.markSent(jobA, ['sent'], 1, SENT_AT);

    expect(notes.listPendingVoice().map((note) => note.id)).toEqual(['b-old', 'a-mid', 'a-new']);
  });

  it('is empty without voice notes', () => {
    expect(setup().notes.listPendingVoice()).toEqual([]);
  });
});

describe('NoteRepository.update', () => {
  it('changes the text and Add to style, and a field left out keeps its value', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Old' });

    expect(notes.update('n1', { text: 'New' })).toMatchObject({ text: 'New', addToStyle: false });
    expect(notes.update('n1', { addToStyle: true })).toMatchObject({
      text: 'New',
      addToStyle: true,
    });
    expect(notes.update('n1', { addToStyle: false })).toMatchObject({
      text: 'New',
      addToStyle: false,
    });
    expect(notes.update('n1', {})).toMatchObject({ text: 'New', addToStyle: false });
    expect(notes.get('n1')).toMatchObject({ text: 'New', addToStyle: false });
  });

  it('is null for a sent note and for an unknown one, and changes nothing', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Old' });
    notes.markSent(jobA, ['n1'], 1, SENT_AT);

    expect(notes.update('n1', { text: 'New', addToStyle: true })).toBeNull();
    expect(notes.update('nope', { text: 'New' })).toBeNull();
    expect(notes.get('n1')).toMatchObject({ text: 'Old', addToStyle: false });
  });
});

describe('NoteRepository.setTranscript', () => {
  const voice = (notes: NoteRepository, jobId: string, id = 'n1') =>
    notes.create({
      id,
      jobId,
      kind: 'voice',
      atSec: 1,
      audioFile: `edit/review/voice/${id}.webm`,
      audioSec: 3,
    });

  it('saves a done transcript with its text', () => {
    const { notes, jobA } = setup();
    voice(notes, jobA);

    const note = notes.setTranscript('n1', { status: 'done', text: 'כאן הכתוביות' });

    expect(note).toMatchObject({ transcriptStatus: 'done', text: 'כאן הכתוביות' });
    expect(notes.get('n1')).toEqual(note);
  });

  it('saves a failed one without text', () => {
    const { notes, jobA } = setup();
    voice(notes, jobA);

    expect(notes.setTranscript('n1', { status: 'failed' })).toMatchObject({
      transcriptStatus: 'failed',
      text: null,
    });
  });

  it('only once: a second outcome, or one for a deleted or unknown note, is null', () => {
    const { notes, jobA } = setup();
    voice(notes, jobA);
    voice(notes, jobA, 'n2');
    notes.setTranscript('n1', { status: 'done', text: 'First' });
    notes.remove('n2');

    expect(notes.setTranscript('n1', { status: 'failed' })).toBeNull();
    expect(notes.setTranscript('n1', { status: 'done', text: 'Second' })).toBeNull();
    expect(notes.setTranscript('n2', { status: 'done', text: 'Late' })).toBeNull();
    expect(notes.setTranscript('nope', { status: 'failed' })).toBeNull();
    expect(notes.get('n1')).toMatchObject({ transcriptStatus: 'done', text: 'First' });
    expect(notes.get('n2')).toBeNull();
  });

  it('never touches a text note', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 't1', jobId: jobA, kind: 'text', atSec: 1, text: 'Typed' });

    expect(notes.setTranscript('t1', { status: 'done', text: 'Other' })).toBeNull();
    expect(notes.get('t1')).toMatchObject({ text: 'Typed', transcriptStatus: null });
  });
});

describe('NoteRepository.remove', () => {
  it('deletes the note and says whether it existed', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'One' });

    expect(notes.remove('n1')).toBe(true);
    expect(notes.remove('n1')).toBe(false);
    expect(notes.get('n1')).toBeNull();
  });
});

describe('NoteRepository.markSent', () => {
  it('stamps the round and sentAt on those notes, returns them by atSec, and leaves the others', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'late', jobId: jobA, kind: 'text', atSec: 9, text: 'Late' });
    notes.create({ id: 'early', jobId: jobA, kind: 'text', atSec: 1, text: 'Early' });
    notes.create({ id: 'kept', jobId: jobA, kind: 'text', atSec: 5, text: 'Kept' });

    const sent = notes.markSent(jobA, ['late', 'early'], 2, SENT_AT);

    expect(sent.map((note) => note.id)).toEqual(['early', 'late']);
    for (const note of sent) expect(note).toMatchObject({ round: 2, sentAt: SENT_AT });
    expect(notes.get('kept')).toMatchObject({ round: null, sentAt: null });
    expect(notes.listUnsent(jobA).map((note) => note.id)).toEqual(['kept']);
  });

  it('sends nothing for an empty list', () => {
    const { notes, jobA } = setup();
    expect(notes.markSent(jobA, [], 1, SENT_AT)).toEqual([]);
  });

  it('throws and writes nothing when one id is sent already', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'One' });
    notes.create({ id: 'n2', jobId: jobA, kind: 'text', atSec: 2, text: 'Two' });
    notes.markSent(jobA, ['n1'], 1, SENT_AT);

    expect(() => notes.markSent(jobA, ['n2', 'n1'], 2, '2026-10-21T10:00:00.000Z')).toThrow(
      /sent already/,
    );

    expect(notes.get('n2')).toMatchObject({ round: null, sentAt: null });
    expect(notes.get('n1')).toMatchObject({ round: 1, sentAt: SENT_AT });
  });

  it('throws and writes nothing when one id is of another job or unknown', () => {
    const { notes, jobA, jobB } = setup();
    notes.create({ id: 'a1', jobId: jobA, kind: 'text', atSec: 1, text: 'A1' });
    notes.create({ id: 'b1', jobId: jobB, kind: 'text', atSec: 1, text: 'B1' });

    expect(() => notes.markSent(jobA, ['a1', 'b1'], 1, SENT_AT)).toThrow(/another job/);
    expect(() => notes.markSent(jobA, ['a1', 'ghost'], 1, SENT_AT)).toThrow(/not found/);

    expect(notes.get('a1')).toMatchObject({ round: null, sentAt: null });
    expect(notes.get('b1')).toMatchObject({ round: null, sentAt: null });
  });

  it('rolls back with the surrounding transaction when it throws inside it', () => {
    const { notes, jobA, db } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'One' });
    notes.create({ id: 'n2', jobId: jobA, kind: 'text', atSec: 2, text: 'Two' });

    expect(() =>
      db.sqlite
        .transaction(() => {
          notes.markSent(jobA, ['n1'], 1, SENT_AT);
          notes.markSent(jobA, ['n2', 'n1'], 1, SENT_AT);
        })
        .immediate(),
    ).toThrow();

    expect(notes.listUnsent(jobA).map((note) => note.id)).toEqual(['n1', 'n2']);
  });
});

describe('NoteRepository.listAllSent', () => {
  it('is empty when nothing was sent', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'draft', jobId: jobA, kind: 'text', atSec: 1, text: 'Not sent' });

    expect(notes.listAllSent()).toEqual([]);
  });

  it('lists the sent notes of every job, oldest sent first, and leaves drafts out', () => {
    const { notes, jobA, jobB } = setup();
    notes.create({ id: 'b1', jobId: jobB, kind: 'text', atSec: 1, text: 'B1' });
    notes.create({ id: 'a1', jobId: jobA, kind: 'text', atSec: 5, text: 'A1' });
    notes.create({ id: 'a2', jobId: jobA, kind: 'text', atSec: 2, text: 'A2' });
    notes.create({ id: 'draft', jobId: jobA, kind: 'text', atSec: 0, text: 'Not sent' });
    notes.markSent(jobB, ['b1'], 1, '2026-10-20T09:00:00.000Z');
    notes.markSent(jobA, ['a1', 'a2'], 1, '2026-10-20T10:00:00.000Z');

    const sent = notes.listAllSent();

    expect(sent.map((note) => note.id)).toEqual(['b1', 'a2', 'a1']);
    expect(sent.map((note) => reviewNoteSchema.parse(note))).toEqual(sent);
    expect(sent.every((note) => note.round !== null && note.sentAt !== null)).toBe(true);
  });

  it('carries the job, the round, the text and the kind of each note', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 't1', jobId: jobA, kind: 'text', atSec: 1, text: 'Cut the intro.' });
    notes.markSent(jobA, ['t1'], 1, SENT_AT);
    notes.create({
      id: 'v1',
      jobId: jobA,
      kind: 'voice',
      atSec: 3,
      audioFile: 'edit/review/voice/v1.webm',
      audioSec: 4,
    });
    notes.setTranscript('v1', { status: 'done', text: 'Louder music.' });
    notes.markSent(jobA, ['v1'], 2, '2026-10-20T11:00:00.000Z');

    expect(notes.listAllSent()).toEqual([
      expect.objectContaining({
        id: 't1',
        jobId: jobA,
        round: 1,
        kind: 'text',
        text: 'Cut the intro.',
        sentAt: SENT_AT,
      }),
      expect.objectContaining({
        id: 'v1',
        jobId: jobA,
        round: 2,
        kind: 'voice',
        text: 'Louder music.',
        sentAt: '2026-10-20T11:00:00.000Z',
      }),
    ]);
  });

  it('puts notes sent at the same moment in the order the Review dialog shows them', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'late', jobId: jobA, kind: 'text', atSec: 9, text: 'Late' });
    notes.create({ id: 'early', jobId: jobA, kind: 'text', atSec: 1, text: 'Early' });
    notes.markSent(jobA, ['late', 'early'], 1, SENT_AT);

    expect(notes.listAllSent().map((note) => note.id)).toEqual(['early', 'late']);
  });
});

describe('NoteRepository.setRoute (quick fixes)', () => {
  const REVISE_ROUTE = {
    tier: 'revise',
    kind: 'Swapping a shot',
    why: 'it changes the cut',
  } as const;
  const QUICK_ROUTE = { tier: 'quick', kind: 'Changing the caption font', why: '' } as const;

  it('starts a note with no sorting at all', () => {
    const { notes, jobA } = setup();

    const note = notes.create({
      id: 'n1',
      jobId: jobA,
      kind: 'text',
      atSec: 1,
      text: 'Heebo Bold',
    });

    expect(note).toMatchObject({ routeStatus: null, route: null, fixId: null, fixedAt: null });
  });

  it('marks a note pending while the router reads it, with no route yet', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });

    const note = notes.setRoute('n1', { status: 'pending' });

    expect(note).toMatchObject({ routeStatus: 'pending', route: null });
    expect(notes.get('n1')).toEqual(note);
    expect(reviewNoteSchema.parse(note)).toEqual(note);
  });

  it('stores the route once it has answered: a quick one with no why, a revise one with its why', () => {
    const { notes, jobA, db } = setup();
    notes.create({ id: 'q', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });
    notes.create({ id: 'r', jobId: jobA, kind: 'text', atSec: 2, text: 'Swap this shot' });

    const quick = notes.setRoute('q', { status: 'routed', route: QUICK_ROUTE });
    const revise = notes.setRoute('r', { status: 'routed', route: REVISE_ROUTE });

    expect(quick).toMatchObject({ routeStatus: 'routed', route: QUICK_ROUTE });
    expect(revise).toMatchObject({ routeStatus: 'routed', route: REVISE_ROUTE });
    expect(reviewNoteSchema.parse(quick)).toEqual(quick);
    expect(reviewNoteSchema.parse(revise)).toEqual(revise);
    expect(rawRow(db, 'review_notes', "id = 'r'")).toEqual([
      expect.objectContaining({
        route_status: 'routed',
        route_tier: 'revise',
        route_kind: 'Swapping a shot',
        route_why: 'it changes the cut',
      }),
    ]);
  });

  it('replaces an earlier route, and a pending mark takes the old route away', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });
    notes.setRoute('n1', { status: 'routed', route: QUICK_ROUTE });

    notes.setRoute('n1', { status: 'routed', route: REVISE_ROUTE });
    expect(notes.get('n1')?.route).toEqual(REVISE_ROUTE);

    notes.setRoute('n1', { status: 'pending' });
    expect(notes.get('n1')).toMatchObject({ routeStatus: 'pending', route: null });
  });

  it('takes the sorting off with null', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });
    notes.setRoute('n1', { status: 'routed', route: REVISE_ROUTE });

    expect(notes.setRoute('n1', null)).toMatchObject({ routeStatus: null, route: null });
  });

  it('changes nothing else about the note', () => {
    const { notes, jobA } = setup();
    const created = notes.create({
      id: 'n1',
      jobId: jobA,
      kind: 'text',
      atSec: 1,
      text: 'Heebo Bold',
    });

    const routed = notes.setRoute('n1', { status: 'routed', route: QUICK_ROUTE });

    expect(routed).toEqual({ ...created, routeStatus: 'routed', route: QUICK_ROUTE });
  });

  it('is null for an unknown note and for one that was sent', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });
    notes.markSent(jobA, ['n1'], 1, SENT_AT);

    expect(notes.setRoute('nope', { status: 'pending' })).toBeNull();
    expect(notes.setRoute('n1', { status: 'pending' })).toBeNull();
    expect(notes.get('n1')).toMatchObject({ routeStatus: null });
  });

  it('stays with the note when it is sent', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Swap this shot' });
    notes.setRoute('n1', { status: 'routed', route: REVISE_ROUTE });

    const [sent] = notes.markSent(jobA, ['n1'], 1, SENT_AT);

    expect(sent).toMatchObject({ round: 1, routeStatus: 'routed', route: REVISE_ROUTE });
    expect(notes.listSent(jobA)[0]?.route).toEqual(REVISE_ROUTE);
  });
});

describe('NoteRepository.listRoutePending (quick fixes)', () => {
  it('lists the unsent notes left pending, of every job, oldest first', () => {
    const { notes, clock, jobA, jobB } = setup();
    notes.create({ id: 'a', jobId: jobA, kind: 'text', atSec: 1, text: 'one' });
    clock.tick(1_000);
    notes.create({ id: 'b', jobId: jobB, kind: 'text', atSec: 1, text: 'two' });
    clock.tick(1_000);
    notes.create({ id: 'c', jobId: jobA, kind: 'text', atSec: 2, text: 'three' });
    notes.setRoute('c', { status: 'pending' });
    notes.setRoute('a', { status: 'pending' });
    notes.setRoute('b', { status: 'pending' });

    expect(notes.listRoutePending().map((note) => note.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out notes that are routed, never sorted, or sent', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'routed', jobId: jobA, kind: 'text', atSec: 1, text: 'one' });
    notes.setRoute('routed', {
      status: 'routed',
      route: { tier: 'quick', kind: 'Changing the font', why: '' },
    });
    notes.create({ id: 'plain', jobId: jobA, kind: 'text', atSec: 2, text: 'two' });
    notes.create({ id: 'sent', jobId: jobA, kind: 'text', atSec: 3, text: 'three' });
    notes.setRoute('sent', { status: 'pending' });
    notes.markSent(jobA, ['sent'], 1, SENT_AT);

    expect(notes.listRoutePending()).toEqual([]);
  });
});

describe('NoteRepository.setFix (quick fixes)', () => {
  it('stores the fix of a note and when it landed, and takes both back after Undo', () => {
    const { notes, jobA, db } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });

    const queued = notes.setFix('n1', { fixId: 'f1', fixedAt: null });
    expect(queued).toMatchObject({ fixId: 'f1', fixedAt: null });

    const fixed = notes.setFix('n1', { fixId: 'f1', fixedAt: '2026-10-25T09:00:48.000Z' });
    expect(fixed).toMatchObject({ fixId: 'f1', fixedAt: '2026-10-25T09:00:48.000Z' });
    expect(reviewNoteSchema.parse(fixed)).toEqual(fixed);
    expect(rawRow(db, 'review_notes', "id = 'n1'")).toEqual([
      expect.objectContaining({ fix_id: 'f1', fixed_at: Date.parse('2026-10-25T09:00:48.000Z') }),
    ]);

    expect(notes.setFix('n1', { fixId: null, fixedAt: null })).toMatchObject({
      fixId: null,
      fixedAt: null,
    });
  });

  it('leaves the route alone, and the route leaves the fix alone', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });
    const route = { tier: 'quick', kind: 'Changing the caption font', why: '' } as const;
    notes.setRoute('n1', { status: 'routed', route });

    notes.setFix('n1', { fixId: 'f1', fixedAt: '2026-10-25T09:00:48.000Z' });
    expect(notes.get('n1')).toMatchObject({ routeStatus: 'routed', route, fixId: 'f1' });

    notes.setRoute('n1', null);
    expect(notes.get('n1')).toMatchObject({ routeStatus: null, route: null, fixId: 'f1' });
  });

  it('is null for an unknown note and for one that was sent, which keeps its fix', () => {
    const { notes, jobA } = setup();
    notes.create({ id: 'n1', jobId: jobA, kind: 'text', atSec: 1, text: 'Heebo Bold' });
    notes.setFix('n1', { fixId: 'f1', fixedAt: '2026-10-25T09:00:48.000Z' });
    notes.markSent(jobA, ['n1'], 1, SENT_AT);

    expect(notes.setFix('nope', { fixId: 'f1', fixedAt: null })).toBeNull();
    expect(notes.setFix('n1', { fixId: null, fixedAt: null })).toBeNull();
    expect(notes.get('n1')).toMatchObject({ round: 1, fixId: 'f1' });
  });
});
