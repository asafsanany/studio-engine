import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import {
  composerKeyAction,
  goToLabel,
  hasPendingTranscript,
  isNoteActive,
  NOTE_ACTIVE_WINDOW_SEC,
  NOTE_COLOR,
  noteDotLabel,
  noteDotSize,
  noteTime,
  recordingLine,
  recordingSpokenLine,
  reviewFooter,
  sendBlockedByRecording,
  sendBlockedByTranscripts,
  sendLabel,
  sentToast,
  sortNotes,
  transcriptLine,
} from './notes-logic';
import type { RecorderSnapshot } from './voice-recorder';

describe('constants', () => {
  it('are the board numbers', () => {
    expect(NOTE_COLOR).toBe('#3B82F6');
    expect(NOTE_ACTIVE_WINDOW_SEC).toBe(1.5);
  });
});

describe('noteTime', () => {
  it.each([
    [0, '0:00'],
    [2.4, '0:02'],
    [59.99, '0:59'],
    [65.9, '1:05'],
    [-1, '0:00'],
    [Number.NaN, '0:00'],
  ])('%s reads %s', (sec, label) => {
    expect(noteTime(sec)).toBe(label);
  });
});

describe('labels', () => {
  it('names a dot for a text note and a voice note', () => {
    expect(noteDotLabel({ kind: 'text', atSec: 2.4 })).toBe('Note at 0:02');
    expect(noteDotLabel({ kind: 'voice', atSec: 7.8 })).toBe('Voice note at 0:07');
  });

  it('names a time chip', () => {
    expect(goToLabel(2.4)).toBe('Go to 0:02');
    expect(goToLabel(65.9)).toBe('Go to 1:05');
  });

  it('sizes the Send button label by the number of notes', () => {
    expect(sendLabel(1)).toBe('Send 1 note');
    expect(sendLabel(3)).toBe('Send 3 notes');
  });
});

describe('sortNotes', () => {
  it('orders by time, then by when it was written, then by id', () => {
    const notes = [
      makeReviewNote({ id: 'c', atSec: 5, createdAt: '2026-10-20T14:00:00.000Z' }),
      makeReviewNote({ id: 'b', atSec: 5, createdAt: '2026-10-20T14:00:00.000Z' }),
      makeReviewNote({ id: 'd', atSec: 5, createdAt: '2026-10-20T13:00:00.000Z' }),
      makeReviewNote({ id: 'a', atSec: 9 }),
      makeReviewNote({ id: 'z', atSec: 1 }),
    ];
    expect(sortNotes(notes).map((note) => note.id)).toEqual(['z', 'd', 'b', 'c', 'a']);
  });

  it('leaves the input as it was', () => {
    const notes = [makeReviewNote({ id: 'a', atSec: 9 }), makeReviewNote({ id: 'z', atSec: 1 })];
    sortNotes(notes);
    expect(notes.map((note) => note.id)).toEqual(['a', 'z']);
  });
});

describe('isNoteActive', () => {
  const note = { id: 'n1', atSec: 4 };

  it('is true for the selected note, playing or not, wherever the playhead is', () => {
    expect(isNoteActive(note, { selectedId: 'n1', playing: false, currentSec: 20 })).toBe(true);
    expect(isNoteActive(note, { selectedId: 'n1', playing: true, currentSec: 0 })).toBe(true);
  });

  it('is true while playing from its time to 1.5 s after it', () => {
    const playing = (currentSec: number) =>
      isNoteActive(note, { selectedId: null, playing: true, currentSec });
    expect(playing(3.99)).toBe(false);
    expect(playing(4)).toBe(true);
    expect(playing(5.49)).toBe(true);
    expect(playing(5.5)).toBe(false);
  });

  it('is false when paused and not selected', () => {
    expect(isNoteActive(note, { selectedId: null, playing: false, currentSec: 4.2 })).toBe(false);
    expect(isNoteActive(note, { selectedId: 'other', playing: false, currentSec: 4.2 })).toBe(
      false,
    );
  });
});

describe('noteDotSize', () => {
  it('is 10 when hovered or active, else 8', () => {
    expect(noteDotSize(false, false)).toBe(8);
    expect(noteDotSize(true, false)).toBe(10);
    expect(noteDotSize(false, true)).toBe(10);
    expect(noteDotSize(true, true)).toBe(10);
  });
});

describe('sentToast', () => {
  it('names the notes, the style ones in a parenthesis, and where the job goes next', () => {
    expect(sentToast(3, 1)).toBe(
      'Sent 3 notes (1 saved to the client style). The job comes back to Review when the changes are done.',
    );
    expect(sentToast(3, 0)).toBe(
      'Sent 3 notes. The job comes back to Review when the changes are done.',
    );
  });

  it('says "note" for one', () => {
    expect(sentToast(1, 0)).toBe(
      'Sent 1 note. The job comes back to Review when the changes are done.',
    );
    expect(sentToast(1, 1)).toBe(
      'Sent 1 note (1 saved to the client style). The job comes back to Review when the changes are done.',
    );
  });
});

describe('reviewFooter', () => {
  const two = [makeReviewNote({ id: 'a' }), makeReviewNote({ id: 'b' })];
  const base = { writing: false, submitting: null, sendDisabledReason: null } as const;

  it('offers Approve, switched off, while the notes load', () => {
    expect(reviewFooter({ ...base, notes: undefined })).toEqual({
      action: 'approve',
      text: 'Happy with it? Approve it from the job’s right-click menu to render the final video.',
      label: 'Approve',
      disabled: true,
      busy: false,
      disabledReason: null,
    });
  });

  it('offers Send with its label when there are notes', () => {
    expect(reviewFooter({ ...base, notes: two })).toEqual({
      action: 'send_notes',
      text: 'Your notes go to the editor together.',
      label: 'Send 2 notes',
      disabled: false,
      busy: false,
      disabledReason: null,
    });
  });

  it('turns Send off while something is submitting, and busy only for its own action', () => {
    expect(reviewFooter({ ...base, notes: two, submitting: 'send_notes' })).toMatchObject({
      disabled: true,
      busy: true,
    });
    expect(reviewFooter({ ...base, notes: two, submitting: 'approve' })).toMatchObject({
      disabled: true,
      busy: false,
    });
  });

  it('turns Send off with a reason, which the tooltip shows', () => {
    expect(
      reviewFooter({ ...base, notes: two, sendDisabledReason: 'Waiting for the voice notes' }),
    ).toMatchObject({
      action: 'send_notes',
      disabled: true,
      disabledReason: 'Waiting for the voice notes',
    });
  });

  it('does not turn Send off because a note is being typed', () => {
    expect(reviewFooter({ ...base, notes: two, writing: true }).disabled).toBe(false);
  });

  it('offers Approve when there are no notes, off while one is being written or submitted', () => {
    expect(reviewFooter({ ...base, notes: [] })).toMatchObject({
      action: 'approve',
      label: 'Approve',
      disabled: false,
      busy: false,
    });
    expect(reviewFooter({ ...base, notes: [], writing: true }).disabled).toBe(true);
    expect(reviewFooter({ ...base, notes: [], submitting: 'approve' })).toMatchObject({
      disabled: true,
      busy: true,
    });
    expect(reviewFooter({ ...base, notes: [], submitting: 'send_notes' })).toMatchObject({
      disabled: true,
      busy: false,
    });
  });

  it('never shows a Send reason on Approve', () => {
    expect(
      reviewFooter({ ...base, notes: [], sendDisabledReason: 'Waiting for the voice notes' })
        .disabledReason,
    ).toBeNull();
  });
});

describe('composerKeyAction', () => {
  const press = (key: string, shiftKey = false, isComposing = false) =>
    composerKeyAction({ key, shiftKey, isComposing });

  it('adds the note on Enter', () => {
    expect(press('Enter')).toBe('add');
  });

  it('types a new line on Shift+Enter, and on the Enter that confirms an IME composition', () => {
    expect(press('Enter', true)).toBeNull();
    expect(press('Enter', false, true)).toBeNull();
  });

  it('leaves every other key alone', () => {
    expect(press('a')).toBeNull();
    expect(press('Escape')).toBeNull();
    expect(press(' ')).toBeNull();
  });
});

describe('hasPendingTranscript and sendBlockedByTranscripts', () => {
  const text = makeReviewNote({ id: 't' });
  const done = makeReviewNote({
    id: 'd',
    kind: 'voice',
    transcriptStatus: 'done',
    text: 'Hello',
  });
  const failed = makeReviewNote({ id: 'f', kind: 'voice', transcriptStatus: 'failed', text: null });
  const pending = makeReviewNote({
    id: 'p',
    kind: 'voice',
    transcriptStatus: 'pending',
    text: null,
  });

  it('is not waiting for anything when there are no notes, or they have not loaded', () => {
    expect(hasPendingTranscript([])).toBe(false);
    expect(hasPendingTranscript(undefined)).toBe(false);
    expect(sendBlockedByTranscripts([])).toBeNull();
    expect(sendBlockedByTranscripts(undefined)).toBeNull();
  });

  it('is not waiting for text notes, or voice notes whose transcript is done or failed', () => {
    expect(hasPendingTranscript([text, done, failed])).toBe(false);
    expect(sendBlockedByTranscripts([text, done, failed])).toBeNull();
  });

  it('waits for a voice note that is still being transcribed, and says so', () => {
    expect(hasPendingTranscript([text, done, pending])).toBe(true);
    expect(sendBlockedByTranscripts([text, done, pending])).toBe(
      'Waiting for the voice notes to be transcribed',
    );
  });

  it('turns Send off in the footer, with that reason for its tooltip', () => {
    const notes = [text, pending];
    expect(
      reviewFooter({
        notes,
        writing: false,
        submitting: null,
        sendDisabledReason: sendBlockedByTranscripts(notes),
      }),
    ).toMatchObject({
      action: 'send_notes',
      disabled: true,
      disabledReason: 'Waiting for the voice notes to be transcribed',
    });
  });
});

describe('transcriptLine', () => {
  it('says "Transcribing…" while the transcript is pending', () => {
    expect(transcriptLine({ kind: 'voice', transcriptStatus: 'pending', text: null })).toBe(
      'Transcribing…',
    );
  });

  it('is the transcript once it is done', () => {
    expect(transcriptLine({ kind: 'voice', transcriptStatus: 'done', text: 'כאן הכתוביות' })).toBe(
      'כאן הכתוביות',
    );
    expect(transcriptLine({ kind: 'voice', transcriptStatus: 'done', text: null })).toBe('');
  });

  it('says the editor will listen to it when the transcript failed', () => {
    expect(transcriptLine({ kind: 'voice', transcriptStatus: 'failed', text: null })).toBe(
      "Couldn't transcribe. The editor will listen to it.",
    );
  });

  it('is empty for a text note, and for a voice note with no status', () => {
    expect(transcriptLine({ kind: 'text', transcriptStatus: null, text: 'Hello' })).toBe('');
    expect(transcriptLine({ kind: 'voice', transcriptStatus: null, text: null })).toBe('');
  });
});

describe('recordingLine', () => {
  const snapshot = (overrides: Partial<RecorderSnapshot>): RecorderSnapshot => ({
    phase: 'recording',
    pinnedSec: 2.4,
    elapsedSec: 0,
    error: null,
    ...overrides,
  });

  it('waits for the microphone while starting', () => {
    expect(recordingLine(snapshot({ phase: 'starting' }))).toBe('Waiting for the microphone…');
  });

  it('counts the time down to the second while recording', () => {
    expect(recordingLine(snapshot({ elapsedSec: 7.9 }))).toBe('Recording 0:07');
    expect(recordingLine(snapshot({ elapsedSec: 0 }))).toBe('Recording 0:00');
    expect(recordingLine(snapshot({ elapsedSec: 65.5 }))).toBe('Recording 1:05');
  });

  it('says the note is being added while it uploads', () => {
    expect(recordingLine(snapshot({ phase: 'saving', elapsedSec: 4 }))).toBe(
      'Adding the voice note…',
    );
  });

  it('gives the reason when the upload failed', () => {
    expect(
      recordingLine(snapshot({ phase: 'failed', error: "Couldn't add the voice note: offline" })),
    ).toBe("Couldn't add the voice note: offline");
  });

  it('gives the error of an idle recorder, or nothing', () => {
    expect(recordingLine(snapshot({ phase: 'idle', error: 'No microphone was found.' }))).toBe(
      'No microphone was found.',
    );
    expect(recordingLine(snapshot({ phase: 'idle' }))).toBe('');
  });
});

describe('recordingSpokenLine', () => {
  const snapshot = (overrides: Partial<RecorderSnapshot>): RecorderSnapshot => ({
    phase: 'recording',
    pinnedSec: 2.4,
    elapsedSec: 0,
    error: null,
    ...overrides,
  });

  it('is "Recording" without the clock while recording, whatever the time', () => {
    for (const elapsedSec of [0, 7.9, 65.5, 299]) {
      expect(recordingSpokenLine(snapshot({ elapsedSec }))).toBe('Recording');
    }
  });

  it('is the visible line in every other phase', () => {
    expect(recordingSpokenLine(snapshot({ phase: 'starting' }))).toBe(
      'Waiting for the microphone…',
    );
    expect(recordingSpokenLine(snapshot({ phase: 'saving', elapsedSec: 4 }))).toBe(
      'Adding the voice note…',
    );
    expect(
      recordingSpokenLine(snapshot({ phase: 'failed', error: "Couldn't add the voice note: x" })),
    ).toBe("Couldn't add the voice note: x");
  });
});

describe('sendBlockedByRecording', () => {
  it('lets Send through while the recorder is idle', () => {
    expect(sendBlockedByRecording({ phase: 'idle' })).toBeNull();
  });

  it.each(['starting', 'recording', 'saving', 'failed'] as const)(
    'blocks Send while the recorder is %s, so no recording is thrown away',
    (phase) => {
      expect(sendBlockedByRecording({ phase })).toBe('Finish or cancel the recording first');
    },
  );

  it('takes a whole snapshot too', () => {
    const snapshot: RecorderSnapshot = {
      phase: 'recording',
      pinnedSec: 2.4,
      elapsedSec: 3,
      error: null,
    };
    expect(sendBlockedByRecording(snapshot)).toBe('Finish or cancel the recording first');
  });

  it('turns Send off in the footer, with that reason for its tooltip', () => {
    const notes = [makeReviewNote({ id: 'a' })];
    expect(
      reviewFooter({
        notes,
        writing: true,
        submitting: null,
        sendDisabledReason: sendBlockedByRecording({ phase: 'recording' }),
      }),
    ).toMatchObject({
      action: 'send_notes',
      disabled: true,
      disabledReason: 'Finish or cancel the recording first',
    });
  });
});
