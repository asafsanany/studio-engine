import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ReviewNoteForFile } from '../review/notes-files.ts';
import {
  REVIEW_NOTE_KINDS,
  REVIEW_NOTE_MAX_LENGTH,
  type ReviewNote,
  reviewNoteKindSchema,
  reviewNoteSchema,
  TRANSCRIPT_STATUSES,
  transcriptStatusSchema,
  VOICE_NOTE_MAX_BYTES,
  VOICE_NOTE_MAX_SEC,
  VOICE_NOTE_TYPES,
  voiceNoteType,
} from './review-note.ts';
import { makeNoteRoute, makeReviewNote } from './test-fixtures.ts';

const voiceNote = (overrides: Partial<ReviewNote> = {}): ReviewNote =>
  makeReviewNote({
    id: 'n2',
    kind: 'voice',
    text: null,
    audioFile: 'edit/review/voice/n2.webm',
    audioSec: 7.5,
    transcriptStatus: 'pending',
    ...overrides,
  });

describe('ReviewNote', () => {
  it('parses an unsent text note unchanged', () => {
    const note = makeReviewNote();
    expect(reviewNoteSchema.parse(note)).toEqual(note);
  });

  it('carries the format it was written on, null for the main one', () => {
    expect(makeReviewNote().format).toBeNull();
    const square = makeReviewNote({ format: '1x1' });
    expect(reviewNoteSchema.parse(square)).toEqual(square);
    expect(reviewNoteSchema.safeParse({ ...square, format: '1:1' }).success).toBe(false);
  });

  it('still parses a note from before formats (no format key) as the main format', () => {
    const { format: _format, ...old } = makeReviewNote();
    expect(reviewNoteSchema.parse(old).format ?? null).toBeNull();
  });

  it('parses a voice note that is pending, done (with its text) and failed', () => {
    for (const note of [
      voiceNote(),
      voiceNote({ transcriptStatus: 'done', text: 'כאן הכתוביות מכסות את הידיים' }),
      voiceNote({ transcriptStatus: 'failed' }),
    ]) {
      expect(reviewNoteSchema.parse(note)).toEqual(note);
    }
  });

  it('parses a sent note and keeps Add to style', () => {
    const note = makeReviewNote({
      round: 2,
      sentAt: '2026-10-20T14:30:00.000Z',
      addToStyle: true,
    });
    expect(reviewNoteSchema.parse(note)).toEqual(note);
  });

  it('parses a note Auto is reading, one it sorted as quick, and one it fixed', () => {
    const pending = makeReviewNote({ routeStatus: 'pending' });
    const routed = makeReviewNote({
      routeStatus: 'routed',
      route: makeNoteRoute({ tier: 'revise', kind: 'Swapping a shot', why: 'it changes the cut' }),
    });
    const fixed = makeReviewNote({
      routeStatus: 'routed',
      route: makeNoteRoute(),
      fixId: 'f1',
      fixedAt: '2026-10-25T09:00:48.000Z',
    });
    for (const note of [pending, routed, fixed]) {
      expect(reviewNoteSchema.parse(note)).toEqual(note);
    }
    // A note nothing sorted has none of it.
    expect(makeReviewNote()).toMatchObject({
      routeStatus: null,
      route: null,
      fixId: null,
      fixedAt: null,
    });
  });

  it('survives a JSON round trip', () => {
    const note = voiceNote({ transcriptStatus: 'done', text: 'Hello שלום' });
    expect(reviewNoteSchema.parse(JSON.parse(JSON.stringify(note)))).toEqual(note);
  });

  it.each([
    ['round 0', { round: 0 }],
    ['a fractional round', { round: 1.5 }],
    ['a negative atSec', { atSec: -1 }],
    ['an unknown kind', { kind: 'video' }],
    ['an unknown transcript status', { transcriptStatus: 'running' }],
    ['empty text', { text: '' }],
    ['an audioSec of 0', { audioSec: 0 }],
    ['a createdAt that is not ISO', { createdAt: 'yesterday' }],
    ['a sentAt that is not ISO', { sentAt: '2026-10-20' }],
    ['an empty id', { id: '' }],
    ['an empty jobId', { jobId: '' }],
    ['addToStyle as a string', { addToStyle: 'true' }],
    ['an unknown route status', { routeStatus: 'reading' }],
    [
      'a route with an unknown tier',
      { route: { tier: 'huge', kind: 'Changing the shot', why: '' } },
    ],
    ['an empty fixId', { fixId: '' }],
    ['a fixedAt that is not ISO', { fixedAt: 'yesterday' }],
  ])('rejects %s', (_label, overrides) => {
    expect(reviewNoteSchema.safeParse({ ...makeReviewNote(), ...overrides }).success).toBe(false);
  });

  it('rejects a note with a missing key', () => {
    const { addToStyle: _addToStyle, ...rest } = makeReviewNote();
    expect(reviewNoteSchema.safeParse(rest).success).toBe(false);
  });

  it('lists the kinds and the transcript statuses', () => {
    expect(REVIEW_NOTE_KINDS).toEqual(['text', 'voice']);
    expect(TRANSCRIPT_STATUSES).toEqual(['pending', 'done', 'failed']);
    expect(reviewNoteKindSchema.safeParse('text').success).toBe(true);
    expect(transcriptStatusSchema.safeParse('done').success).toBe(true);
    expect(transcriptStatusSchema.safeParse('no_speech').success).toBe(false);
  });

  it('satisfies the round file input as it is', () => {
    const forFile: ReviewNoteForFile = makeReviewNote();
    expect(forFile.atSec).toBe(2.4);
    expectTypeOf<ReviewNote>().toExtend<ReviewNoteForFile>();
  });
});

describe('voice note limits', () => {
  it('has the documented numbers', () => {
    expect(REVIEW_NOTE_MAX_LENGTH).toBe(2000);
    expect(VOICE_NOTE_MAX_BYTES).toBe(26_214_400);
    expect(VOICE_NOTE_MAX_SEC).toBe(300);
    expect(VOICE_NOTE_TYPES).toEqual(['audio/webm', 'audio/mp4']);
  });
});

describe('voiceNoteType', () => {
  it.each([
    ['audio/webm', 'audio/webm'],
    ['audio/webm;codecs=opus', 'audio/webm'],
    ['audio/webm; codecs=opus', 'audio/webm'],
    ['AUDIO/MP4', 'audio/mp4'],
    ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'],
  ])('%s is %s', (contentType, expected) => {
    expect(voiceNoteType(contentType)).toBe(expected);
  });

  it.each(['video/webm', '', 'audio/ogg', 'audio/webmx', 'webm'])(
    '%j is not a voice note',
    (type) => {
      expect(voiceNoteType(type)).toBeNull();
    },
  );
});
