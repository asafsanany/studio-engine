import { voiceNoteType } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import { makeReviewNote } from '@/data/test-utils';
import { fixFooter } from '@/features/review/fix-lines';
import { makeOpenFix, makeQuickFix, routedNote } from '@/features/review/fix-test-helpers';
import { reviewFooter } from '@/features/review/notes-logic';
import { pickRecordingMimeType, type RecorderPhase } from '@/features/review/voice-recorder';
import {
  effortChoices,
  KEYBOARD_MIN_HEIGHT,
  keyboardFrame,
  NOTES_STAGE_HEIGHT,
  PHONE_REVIEW_TEXT,
  type PhoneDone,
  phoneDoneLine,
  phoneFooter,
  phoneReviewMode,
  phoneStageLayout,
  pinTime,
  recorderWhenHidden,
  WRITE_STAGE_HEIGHT,
  WRITE_STAGE_MIN_HEIGHT,
} from './phone-review';

const note = (id: string, overrides = {}) => makeReviewNote({ id, ...overrides });

function footerOf(
  notes: ReturnType<typeof note>[] | undefined,
  {
    effort = null,
    done = null,
    submitting = null,
    sendDisabledReason = null,
  }: {
    effort?: 'medium' | 'high' | 'xhigh' | null;
    done?: PhoneDone | null;
    submitting?: 'send_notes' | 'approve' | null;
    sendDisabledReason?: string | null;
  } = {},
) {
  return phoneFooter({
    footer: reviewFooter({ notes, writing: false, submitting, sendDisabledReason }),
    effort,
    done,
  });
}

describe('phoneStageLayout (the shrink state)', () => {
  it('fills the space between the header and the controls while the notes are shut', () => {
    const layout = phoneStageLayout({ notesOpen: false });
    expect(layout).toMatchObject({ mode: 'fill', height: null });
    expect(layout.column).toContain('flex-1');
    expect(layout.stage).toContain('flex-1');
    expect(layout.stage).not.toMatch(/\bh-\[/);
  });

  it('shrinks to 260 px above the notes list while it is open', () => {
    const layout = phoneStageLayout({ notesOpen: true });
    expect(NOTES_STAGE_HEIGHT).toBe(260);
    expect(layout).toMatchObject({ mode: 'shrunk', height: 260 });
    expect(layout.stage).toContain('h-[260px]');
    // The column no longer grows: the list takes what is left.
    expect(layout.column).toBe('flex-none');
  });

  it('is 200 px while a note is written, above the list and the note box (MReviewWrite)', () => {
    const layout = phoneStageLayout({ notesOpen: true, writing: true });
    expect(WRITE_STAGE_HEIGHT).toBe(200);
    expect(layout).toMatchObject({ mode: 'write', height: 200, column: 'flex-none' });
    expect(layout.stage).toBe('h-[200px] shrink-0');
  });

  it('with the keyboard up it takes what is left above the note box, and never less than 120 px', () => {
    const layout = phoneStageLayout({ notesOpen: true, writing: true, keyboardOpen: true });
    expect(WRITE_STAGE_MIN_HEIGHT).toBe(120);
    expect(layout).toMatchObject({ mode: 'write', height: null });
    expect(layout.stage).toBe('min-h-[120px] flex-1');
    expect(layout.column).toBe('min-h-0 flex-1');
  });

  it('writing with the notes shut fills, as the board does; the keyboard alone changes nothing', () => {
    expect(phoneStageLayout({ notesOpen: false, writing: true })).toEqual(
      phoneStageLayout({ notesOpen: false }),
    );
    expect(phoneStageLayout({ notesOpen: false, writing: true, keyboardOpen: true }).mode).toBe(
      'write',
    );
    expect(phoneStageLayout({ notesOpen: true, keyboardOpen: true })).toEqual(
      phoneStageLayout({ notesOpen: true }),
    );
  });
});

describe('phoneReviewMode (what sits under the notes, and what steps aside)', () => {
  const mode = (
    over: Partial<{
      writing: boolean;
      recorderPhase: RecorderPhase;
      finished: boolean;
      keyboardOpen: boolean;
    }> = {},
  ) =>
    phoneReviewMode({
      writing: false,
      recorderPhase: 'idle',
      finished: false,
      keyboardOpen: false,
      ...over,
    });

  it('watching: the footer, the header and the row of buttons; the video plays', () => {
    expect(mode()).toEqual({
      bottom: 'footer',
      showHeader: true,
      showNotes: true,
      showButtons: true,
      playLocked: false,
    });
  });

  it('writing (MReviewWrite): the note box in the footer’s place, the row stays, the video holds', () => {
    expect(mode({ writing: true })).toEqual({
      bottom: 'write',
      showHeader: true,
      showNotes: true,
      showButtons: true,
      playLocked: true,
    });
  });

  it('writing with the keyboard up: the header, the list and the row step aside for the frame', () => {
    expect(mode({ writing: true, keyboardOpen: true })).toEqual({
      bottom: 'write',
      showHeader: false,
      showNotes: false,
      showButtons: false,
      playLocked: true,
    });
  });

  it.each(['starting', 'recording', 'saving', 'failed'] as const)(
    'recording (MReviewRec), %s: the red bar in the footer’s place, no row, the video holds',
    (phase) => {
      expect(mode({ recorderPhase: phase })).toEqual({
        bottom: 'record',
        showHeader: true,
        showNotes: true,
        showButtons: false,
        playLocked: true,
      });
    },
  );

  it('after Send or Approve: the done footer, no row, whatever else is going on', () => {
    expect(mode({ finished: true, writing: true, recorderPhase: 'saving' })).toEqual({
      bottom: 'footer',
      showHeader: true,
      showNotes: false,
      showButtons: false,
      playLocked: false,
    });
  });
});

describe('keyboardFrame (100vh lies while the keyboard is up)', () => {
  it('no keyboard: the page is all visible, and the review keeps its own height', () => {
    expect(keyboardFrame({ layoutHeight: 844, viewportHeight: 844, offsetTop: 0 })).toEqual({
      keyboardOpen: false,
      box: null,
    });
  });

  it('the keyboard covers the bottom: the review is the part left visible, so the note box sits on it', () => {
    // A 390×844 iPhone with the keyboard and its predictive bar: 336 px.
    expect(keyboardFrame({ layoutHeight: 844, viewportHeight: 508, offsetTop: 0 })).toEqual({
      keyboardOpen: true,
      box: { top: 0, height: 508 },
    });
  });

  it('Safari scrolled what is visible down to the field: the review moves down with it', () => {
    expect(keyboardFrame({ layoutHeight: 844, viewportHeight: 464.4, offsetTop: 120.6 })).toEqual({
      keyboardOpen: true,
      box: { top: 121, height: 464 },
    });
  });

  it('a few px less (a toolbar, a rounding) is not a keyboard', () => {
    expect(KEYBOARD_MIN_HEIGHT).toBe(120);
    expect(
      keyboardFrame({ layoutHeight: 844, viewportHeight: 844 - 119, offsetTop: 0 }).keyboardOpen,
    ).toBe(false);
    expect(
      keyboardFrame({ layoutHeight: 844, viewportHeight: 844 - 120, offsetTop: 0 }).keyboardOpen,
    ).toBe(true);
  });
});

describe('pinTime (where a note made now goes)', () => {
  it('is the playhead, as it is', () => {
    expect(pinTime(21.37, 44)).toBe(21.37);
  });

  it('stays within the video', () => {
    expect(pinTime(50, 44)).toBe(44);
    expect(pinTime(-1, 44)).toBe(0);
    expect(pinTime(Number.NaN, 44)).toBe(0);
  });

  it('before the length is known, anything from 0 up', () => {
    expect(pinTime(3.2, 0)).toBe(3.2);
    expect(pinTime(-2, 0)).toBe(0);
    expect(pinTime(Number.NaN, 0)).toBe(0);
  });
});

describe('recorderWhenHidden (the screen locks while recording)', () => {
  it('a recording that runs stops and is added, so what was said is kept', () => {
    expect(recorderWhenHidden('recording')).toBe('stop');
  });

  it('one still waiting for the microphone is dropped: nothing was recorded', () => {
    expect(recorderWhenHidden('starting')).toBe('cancel');
  });

  it.each(['idle', 'saving', 'failed'] as const)('%s goes on as it is', (phase) => {
    expect(recorderWhenHidden(phase)).toBeNull();
  });
});

describe('what iPhone Safari records, and that the engine takes it', () => {
  it('Safari before 18.4 can record only mp4: the recorder takes audio/mp4, which the engine accepts', () => {
    const safari = (type: string) => type === 'audio/mp4';
    const mime = pickRecordingMimeType(safari);
    expect(mime).toBe('audio/mp4');
    expect(voiceNoteType(mime ?? '')).toBe('audio/mp4');
    // What Safari's MediaRecorder reports once it records (the Blob's type), with its codec.
    expect(voiceNoteType('audio/mp4;codecs=mp4a.40.2')).toBe('audio/mp4');
  });

  it('a Safari that can record both takes webm/opus first, which the engine accepts too', () => {
    const mime = pickRecordingMimeType(() => true);
    expect(mime).toBe('audio/webm;codecs=opus');
    expect(voiceNoteType(mime ?? '')).toBe('audio/webm');
  });
});

describe('phoneFooter (one action at a time)', () => {
  it('with no notes it is only the line that says where Approve is: no button, no Effort', () => {
    const view = footerOf([]);
    expect(view).toEqual({
      kind: 'approve',
      text: 'Happy with it? Press and hold the job in the list and choose Approve to render the final video.',
    });
    expect(view).not.toHaveProperty('effortLabel');
  });

  it('with notes it is Effort ▾ and Send N notes', () => {
    const view = footerOf([note('a'), note('b')]);
    expect(view).toMatchObject({
      kind: 'send',
      label: 'Send 2 notes',
      disabled: false,
      effortLabel: 'Effort: Default',
    });
    expect(footerOf([note('a')])).toMatchObject({ kind: 'send', label: 'Send 1 note' });
  });

  it('says the job’s level on the Effort button', () => {
    expect(footerOf([note('a')], { effort: 'high' })).toMatchObject({
      effortLabel: 'Effort: High',
    });
    expect(footerOf([note('a')], { effort: 'xhigh' })).toMatchObject({
      effortLabel: 'Effort: Extra high',
    });
  });

  it('waits for a transcript, giving the reason', () => {
    const view = footerOf([note('a')], {
      sendDisabledReason: 'Waiting for the voice notes to be transcribed',
    });
    expect(view).toMatchObject({
      kind: 'send',
      disabled: true,
      disabledReason: 'Waiting for the voice notes to be transcribed',
    });
  });

  it('shows Send busy while its request is on its way', () => {
    expect(footerOf([note('a')], { submitting: 'send_notes' })).toMatchObject({
      kind: 'send',
      busy: true,
      disabled: true,
    });
  });

  it('has no Send while the notes load', () => {
    expect(footerOf(undefined)).toMatchObject({ kind: 'approve' });
  });

  it('after either went through it is the done line, whatever the notes now say', () => {
    const done: PhoneDone = { action: 'approve', notes: 0, styled: 0, effort: null };
    expect(footerOf([], { done })).toEqual({ kind: 'done', text: PHONE_REVIEW_TEXT.approvedDone });
    // The sent notes are gone from the list: it would read as "Approve", but the line stays.
    const sent: PhoneDone = { action: 'send_notes', notes: 2, styled: 0, effort: null };
    expect(footerOf([], { done: sent })).toMatchObject({ kind: 'done' });
  });
});

describe('phoneDoneLine (board MReviewDone)', () => {
  it('Approve: the final video is rendering', () => {
    expect(phoneDoneLine({ action: 'approve', notes: 0, styled: 0, effort: null })).toBe(
      'Approved. The final video is rendering; the job shows Approved when it’s done.',
    );
  });

  it('Send: how many notes, how many went to the style, and the level of the fixes', () => {
    expect(phoneDoneLine({ action: 'send_notes', notes: 2, styled: 1, effort: 'high' })).toBe(
      'Sent 2 notes (1 saved to the client style). The fixes run at High; the job comes back to Review when they’re done.',
    );
    expect(phoneDoneLine({ action: 'send_notes', notes: 1, styled: 0, effort: 'medium' })).toBe(
      'Sent 1 note. The fixes run at Medium; the job comes back to Review when they’re done.',
    );
  });

  it('Send at Default says the level Default runs at', () => {
    expect(phoneDoneLine({ action: 'send_notes', notes: 3, styled: 0, effort: null })).toContain(
      'The fixes run at Extra high;',
    );
  });
});

describe('effortChoices (the Effort sheet)', () => {
  it('are the four choices of the Mac’s menu, in order, with the hints', () => {
    const choices = effortChoices(null);
    expect(choices.map((choice) => [choice.label, choice.hint])).toEqual([
      ['Default', 'Extra high'],
      ['Medium', 'quickest'],
      ['High', 'slower'],
      ['Extra high', 'slowest'],
    ]);
  });

  it('checks the job’s level, and Default for none', () => {
    expect(effortChoices(null).map((choice) => choice.checked)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(effortChoices('high').map((choice) => choice.checked)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(effortChoices('xhigh').map((choice) => choice.checked)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('draws a rule under Default only', () => {
    expect(effortChoices(null).map((choice) => choice.ruleAbove)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it('gives each choice a gauge', () => {
    for (const choice of effortChoices(null)) expect(choice.icon).toBeTruthy();
  });
});

describe('with Quick fixes on (Auto)', () => {
  it('effortChoices: Auto (Default, with its line of help, sparkles), a rule, then the levels waiting for Send', () => {
    const choices = effortChoices(null, true);
    expect(choices.map((choice) => [choice.id, choice.label, choice.hint, choice.sub])).toEqual([
      [
        'auto',
        'Auto',
        'Default',
        'Text, font and title notes are fixed here at once. The rest runs at the level it needs.',
      ],
      ['medium', 'Medium', 'waits for Send', null],
      ['high', 'High', 'waits for Send', null],
      ['xhigh', 'Extra high', 'waits for Send', null],
    ]);
    expect(choices.map((choice) => choice.ruleAbove)).toEqual([false, true, false, false]);
  });

  it('effortChoices: sparkles for Auto and a gauge per level', () => {
    expect(effortChoices(null, true).map((choice) => choice.icon)).toEqual([
      effortIcon('auto'),
      gaugeIcon('medium'),
      gaugeIcon('high'),
      gaugeIcon('xhigh'),
    ]);
  });

  it('effortChoices: checks Auto for null and the level otherwise', () => {
    const checked = (effort: Parameters<typeof effortChoices>[0]) =>
      effortChoices(effort, true).map((choice) => choice.checked);
    expect(checked(null)).toEqual([true, false, false, false]);
    expect(checked('medium')).toEqual([false, true, false, false]);
    expect(checked('xhigh')).toEqual([false, false, false, true]);
  });

  it('effortChoices without Auto stay Default and the three levels, with gauges', () => {
    const choices = effortChoices(null);
    expect(choices.map((choice) => choice.id)).toEqual(['default', 'medium', 'high', 'xhigh']);
    expect(choices.every((choice) => choice.sub === null)).toBe(true);
    expect(choices[0]?.icon).toBe(gaugeIcon(null));
  });

  it('the Effort button says Auto for null, and the level otherwise', () => {
    const footer = (effort: 'medium' | 'high' | 'xhigh' | null, auto: boolean) =>
      phoneFooter({
        footer: reviewFooter({
          notes: [note('a')],
          writing: false,
          submitting: null,
          sendDisabledReason: null,
        }),
        effort,
        auto,
        done: null,
      });
    expect(footer(null, true)).toMatchObject({ effortLabel: 'Effort: Auto' });
    expect(footer('high', true)).toMatchObject({ effortLabel: 'Effort: High' });
    expect(footer(null, false)).toMatchObject({ effortLabel: 'Effort: Default' });
  });

  it('the done line does not name a level for Auto', () => {
    const done: PhoneDone = { action: 'send_notes', notes: 2, styled: 0, effort: null, auto: true };
    expect(phoneDoneLine(done)).toBe(
      'Sent 2 notes. The fixes run at the level each one needs; the job comes back to Review when they’re done.',
    );
    expect(phoneDoneLine({ ...done, effort: 'high' })).toContain('The fixes run at High;');
    expect(phoneDoneLine({ ...done, auto: false })).toContain('The fixes run at Extra high;');
  });

  it('keeps a line for screen readers under the sheet’s title', () => {
    expect(PHONE_REVIEW_TEXT.effortHintAuto).toBe(
      'Auto picks the level for each note. A level you choose holds every note for Send.',
    );
  });
});

describe('phoneFooter with Quick fixes on: the footer’s line and the Effort button waiting', () => {
  const footerWith = (
    notes: Parameters<typeof fixFooter>[0]['notes'],
    fixes: Parameters<typeof fixFooter>[0]['fixes'],
  ) =>
    phoneFooter({
      footer: fixFooter({
        notes,
        fixes,
        auto: true,
        loaded: true,
        writing: false,
        submitting: null,
        sendDisabledReason: null,
      }),
      effort: null,
      auto: true,
      done: null,
    });

  it('a fix under way: the action and the Effort button wait, and the line says why', () => {
    const view = footerWith(
      [routedNote('quick', { id: 'a' }), routedNote('revise', { id: 'b' })],
      [makeOpenFix('running', { id: 'fa', noteId: 'a' })],
    );
    expect(view).toMatchObject({
      kind: 'send',
      label: 'Send 1 note',
      disabled: true,
      effortDisabled: true,
      note: 'Fixing it here. Send waits for it.',
    });
  });

  it('a fix under way and nothing else: the line says Approve waits', () => {
    expect(footerWith([routedNote('quick')], [makeOpenFix('queued')])).toEqual({
      kind: 'approve',
      text: 'Fixing it here. Approve waits for it.',
    });
  });

  it('notes that wait on Auto: Send, with Auto’s plan as the line', () => {
    const view = footerWith([routedNote('revise')], []);
    expect(view).toMatchObject({
      kind: 'send',
      label: 'Send 1 note',
      disabled: false,
      effortLabel: 'Effort: Auto',
      note: 'Auto sends 1 note to Sonnet at High, 2 to 10 min.',
    });
    expect(view).not.toHaveProperty('effortDisabled');
  });

  it('only fixed notes: the line says so, and where Approve is on the phone', () => {
    expect(footerWith([routedNote('quick', { fixId: 'f1' })], [makeQuickFix()])).toEqual({
      kind: 'approve',
      text: 'Fixed here. Press and hold the job in the list and choose Approve to render the final video, or keep writing notes.',
    });
  });

  it('with the switch off the footer has no line and no waiting Effort button', () => {
    const view = footerOf([note('a')]);
    expect(view).not.toHaveProperty('note');
    expect(view).not.toHaveProperty('effortDisabled');
  });
});
