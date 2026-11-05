import type { ReviewNote } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { effortValue, noteRow, roundTitle, SHEET_NOTES_TEXT, sentRounds } from './sheet-notes';
import { JOB_SHEET_STATES, jobSheetJobs, jobSheetNotes, jobSheetNow } from './test-fixtures';

// "Now" for the tests that build their own notes: the afternoon of the day they were sent on.
const NOW = '2026-10-22T13:00:00.000Z';

const sent = (overrides: Partial<ReviewNote>): ReviewNote =>
  makeReviewNote({
    round: 1,
    sentAt: '2026-10-22T12:10:00.000Z',
    createdAt: '2026-10-22T12:05:00.000Z',
    ...overrides,
  });

describe('noteRow', () => {
  it('says "No note" with an Add button for a job with no note', () => {
    const row = noteRow({ ...jobSheetJobs.queued, note: null });
    expect(row).toEqual({ text: null, action: 'Add', canChange: true });
  });

  it('shows the note with an Edit button once the job has one', () => {
    const row = noteRow({ ...jobSheetJobs.queued, note: 'Use the new logo' });
    expect(row).toEqual({ text: 'Use the new logo', action: 'Edit', canChange: true });
  });

  it('works exactly where the row menu’s Add note… / Edit note… does', () => {
    const can = Object.fromEntries(
      JOB_SHEET_STATES.map((state) => [state, noteRow(jobSheetJobs[state]).canChange]),
    );
    expect(can).toEqual({
      arriving: true,
      queued: true,
      held: true,
      editing: false,
      failed: true,
      cancelled: true,
      review: false,
      reviewRound2: false,
      rendering: false,
      approved: false,
      delivered: false,
      paid: false,
      archived: false,
    });
  });
});

describe('effortValue', () => {
  it('names the level, and for Default the level it runs at', () => {
    expect(effortValue('medium')).toBe('Medium');
    expect(effortValue('high')).toBe('High');
    expect(effortValue('xhigh')).toBe('Extra high');
    expect(effortValue(null)).toBe('Extra high');
  });
});

describe('roundTitle', () => {
  it('says the round and when it was sent: the clock time for a round sent today', () => {
    expect(roundTitle(2, '2026-10-22T12:10:00.000Z', NOW, 'UTC')).toBe(
      'Your notes in round 2 · sent 12:10',
    );
    expect(roundTitle(2, '2026-10-22T09:05:00.000Z', NOW, 'UTC')).toBe(
      'Your notes in round 2 · sent 09:05',
    );
    expect(roundTitle(2, '2026-10-22T00:05:00.000Z', NOW, 'UTC')).toBe(
      'Your notes in round 2 · sent 00:05',
    );
    expect(roundTitle(2, '2026-10-22T12:10:00.000Z', NOW, 'Asia/Tokyo')).toBe(
      'Your notes in round 2 · sent 21:10',
    );
  });

  it('says the day instead for a round sent on an earlier day, as the History part does', () => {
    expect(roundTitle(1, '2026-10-21T21:54:00.000Z', NOW, 'UTC')).toBe(
      'Your notes in round 1 · sent 21 Oct',
    );
    expect(roundTitle(1, '2026-09-03T21:54:00.000Z', NOW, 'UTC')).toBe(
      'Your notes in round 1 · sent 3 Sep',
    );
  });

  it('goes by the calendar day on the given wall clock, not by 24 hours', () => {
    // 23:30 the evening before is yesterday, though it is only 90 minutes earlier.
    expect(roundTitle(1, '2026-10-21T23:30:00.000Z', '2026-10-22T01:00:00.000Z', 'UTC')).toBe(
      'Your notes in round 1 · sent 21 Oct',
    );
    // In Tokyo (UTC+9) both instants are on the 22nd: the same moment is today there.
    expect(
      roundTitle(1, '2026-10-21T15:30:00.000Z', '2026-10-22T01:00:00.000Z', 'Asia/Tokyo'),
    ).toBe('Your notes in round 1 · sent 00:30');
  });

  it('leaves the time out when there is none to say', () => {
    expect(roundTitle(2, '', NOW, 'UTC')).toBe('Your notes in round 2');
    expect(roundTitle(2, 'not a time', NOW, 'UTC')).toBe('Your notes in round 2');
  });
});

describe('sentRounds', () => {
  it('has no rounds for nothing, or while the notes have not arrived', () => {
    expect(sentRounds(undefined, NOW)).toEqual([]);
    expect(sentRounds([], NOW)).toEqual([]);
  });

  it('is round 1 of the "Ready to review · round 2" board: three notes, their marks and the voice note', () => {
    expect(sentRounds(jobSheetNotes.reviewRound2, jobSheetNow.reviewRound2, 'UTC')).toEqual([
      {
        round: 1,
        title: 'Your notes in round 1 · sent 12:10',
        notes: [
          {
            id: 'rr2-n1',
            time: '0:04',
            text: 'Make the WhatsApp question card come in faster',
            voice: null,
            marks: ['Series'],
          },
          {
            id: 'rr2-n2',
            time: '0:19',
            text: null,
            voice: {
              label: 'Voice note · 0:07',
              transcript: { kind: 'text', text: 'תוריד פה את המוזיקה, היא חזקה מדי על הדיבור' },
            },
            marks: ['Style'],
          },
          { id: 'rr2-n3', time: '0:33', text: 'Cut the second “אממ”', voice: null, marks: [] },
        ],
      },
    ]);
  });

  it('leaves drafts out, and with only drafts there is nothing to show', () => {
    const draft = makeReviewNote({ id: 'draft', round: null, sentAt: null });
    expect(sentRounds([draft], NOW)).toEqual([]);
    const rounds = sentRounds([draft, sent({ id: 'kept', atSec: 3 })], NOW, 'UTC');
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.notes.map((note) => note.id)).toEqual(['kept']);
  });

  it('leaves out a note that has no round, since it could not be named', () => {
    const odd = makeReviewNote({ id: 'odd', round: null, sentAt: '2026-10-22T12:10:00.000Z' });
    expect(sentRounds([odd], NOW)).toEqual([]);
  });

  it('groups the notes by round, oldest round first, whatever order they arrive in', () => {
    const notes = [
      sent({ id: 'b2', round: 2, atSec: 5, sentAt: '2026-10-22T09:55:00.000Z' }),
      sent({ id: 'a2', round: 1, atSec: 30 }),
      sent({ id: 'b1', round: 2, atSec: 1, sentAt: '2026-10-22T09:55:00.000Z' }),
      sent({ id: 'a1', round: 1, atSec: 2 }),
    ];
    const rounds = sentRounds(notes, NOW, 'UTC');
    expect(rounds.map((round) => [round.round, round.title])).toEqual([
      [1, 'Your notes in round 1 · sent 12:10'],
      [2, 'Your notes in round 2 · sent 09:55'],
    ]);
    // Within a round, by their time in the video.
    expect(rounds.map((round) => round.notes.map((note) => note.id))).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
  });

  it('keeps two rounds of the archived job apart, each with its own sent time', () => {
    const rounds = sentRounds(jobSheetNotes.archived, jobSheetNow.archived, 'UTC');
    expect(rounds.map((round) => [round.title, round.notes.length])).toEqual([
      ['Your notes in round 1 · sent 10 Sep', 2],
      ['Your notes in round 2 · sent 11 Sep', 1],
    ]);
  });

  it('says a round was sent when its first note went', () => {
    const rounds = sentRounds(
      [
        sent({ id: 'late', sentAt: '2026-10-22T12:12:00.000Z' }),
        sent({ id: 'early', sentAt: '2026-10-22T12:10:00.000Z' }),
      ],
      NOW,
      'UTC',
    );
    expect(rounds[0]?.title).toBe('Your notes in round 1 · sent 12:10');
  });

  it('puts the time in the video as m:ss, rounded down', () => {
    const [round] = sentRounds([sent({ atSec: 65.9 }), sent({ id: 'n2', atSec: 0.4 })], NOW);
    expect(round?.notes.map((note) => note.time)).toEqual(['0:00', '1:05']);
  });

  it('tags a note Style, Series, or both', () => {
    const [round] = sentRounds(
      [
        sent({ id: 'none', atSec: 1 }),
        sent({ id: 'style', atSec: 2, addToStyle: true }),
        sent({ id: 'series', atSec: 3, addToSeries: true }),
        sent({ id: 'both', atSec: 4, addToStyle: true, addToSeries: true }),
      ],
      NOW,
    );
    expect(round?.notes.map((note) => note.marks)).toEqual([
      [],
      ['Style'],
      ['Series'],
      ['Style', 'Series'],
    ]);
  });
});

describe('sentRounds: voice notes', () => {
  const voice = (overrides: Partial<ReviewNote>) =>
    sent({
      kind: 'voice',
      audioFile: 'edit/review/voice/v.webm',
      audioSec: 7,
      text: null,
      transcriptStatus: 'done',
      ...overrides,
    });
  const only = (note: ReviewNote) => sentRounds([note], NOW)[0]?.notes[0];

  it('shows a done transcript, with the length of the recording', () => {
    expect(only(voice({ text: 'Lower the music' }))).toMatchObject({
      text: null,
      voice: { label: 'Voice note · 0:07', transcript: { kind: 'text', text: 'Lower the music' } },
    });
  });

  it('says it is being transcribed while the transcript is on its way', () => {
    expect(only(voice({ transcriptStatus: 'pending' }))?.voice?.transcript).toEqual({
      kind: 'pending',
    });
  });

  it('says there is no transcript when it failed, or came out empty', () => {
    expect(only(voice({ transcriptStatus: 'failed' }))?.voice?.transcript).toEqual({
      kind: 'none',
    });
    expect(only(voice({ transcriptStatus: 'done', text: null }))?.voice?.transcript).toEqual({
      kind: 'none',
    });
    expect(only(voice({ transcriptStatus: 'done', text: '  ' }))?.voice?.transcript).toEqual({
      kind: 'none',
    });
  });

  it('names a recording of unknown length without one', () => {
    expect(only(voice({ audioSec: null, text: 'x' }))?.voice?.label).toBe('Voice note');
  });

  it('gives a typed note no voice line', () => {
    expect(only(sent({ text: 'Cut it' }))).toMatchObject({ text: 'Cut it', voice: null });
  });

  it('uses Review’s words for the voice line and for "Transcribing…"', () => {
    expect(SHEET_NOTES_TEXT.voiceNote).toBe('Voice note');
    expect(SHEET_NOTES_TEXT.transcribing).toBe('Transcribing…');
    expect(SHEET_NOTES_TEXT.noTranscript).toBe('No transcript');
  });
});
