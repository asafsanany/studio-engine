import { type QuickFix, type ReviewNote, TIER_MINUTES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import {
  activeFixByNote,
  type FixContext,
  type FixLineContext,
  fill,
  fixFooter,
  fixIsBusy,
  fixNoteState,
  minutesText,
  modelName,
  newestFixedId,
  noteFixLine,
  noteFixLines,
  startsRtl,
  tierRunName,
  waitingNotes,
  waitingTier,
} from './fix-lines';
import { makeOpenFix, makeQuickFix, routedNote } from './fix-test-helpers';
import { reviewFooter } from './notes-logic';
import { FIX_TEXT, FOOTER_TEXT } from './review-text';

// The rules of the line under a note and of the footer with Quick fixes on (boards QFReview and
// QFStates): which words, which icon's kind, who gets Undo and who can be deleted.

const AUTO: FixContext = { auto: true, loaded: true };
const LEVEL: FixContext = { auto: false, loaded: true };
const LINE_CONTEXT: FixLineContext = { ...AUTO, newestFixedId: null, busy: false };

const reading = makeReviewNote({ id: 'r', routeStatus: 'pending' });

describe('noteFixLine: one line for each place a note can be in', () => {
  const cases: {
    name: string;
    note: ReviewNote;
    fix: QuickFix | null;
    context?: Partial<typeof LINE_CONTEXT>;
    kind: string;
    text: string;
    tail?: string;
  }[] = [
    {
      name: 'the router is reading it',
      note: reading,
      fix: null,
      kind: 'reading',
      text: 'Reading the note…',
    },
    {
      name: 'its fix is queued',
      note: routedNote('quick'),
      fix: makeOpenFix('queued'),
      kind: 'queued',
      text: 'Quick fix · next in line',
    },
    {
      name: 'its fix is running at a step',
      note: routedNote('quick'),
      fix: makeOpenFix('running', { step: 2, stepLabel: 'Checking it' }),
      kind: 'running',
      text: 'Fixing it now · Checking it',
    },
    {
      name: 'its fix landed (the newest one)',
      note: routedNote('quick', { fixId: 'f1' }),
      fix: makeQuickFix({ durationSec: 38 }),
      context: { newestFixedId: 'f1' },
      kind: 'fixed',
      text: 'Fixed in 38 s.',
      tail: 'The captions are Heebo Bold now.',
    },
    {
      name: 'it is routed revise, with no fix',
      note: routedNote('revise'),
      fix: null,
      kind: 'sends',
      text: 'Goes with Send · it changes the cut',
    },
    {
      name: 'it is routed full, with no fix',
      note: routedNote('full'),
      fix: null,
      kind: 'sends',
      text: 'Goes with Send · it changes the whole video',
    },
    {
      name: 'its fix was escalated',
      note: routedNote('quick'),
      fix: makeQuickFix({
        status: 'escalated',
        why: 'the sign is part of the footage',
        said: null,
      }),
      kind: 'escalated',
      text: 'Couldn’t do it here: the sign is part of the footage. It goes with Send.',
    },
    {
      name: 'its fix failed',
      note: routedNote('quick'),
      fix: makeQuickFix({ status: 'failed', why: 'the fix was stopped', said: null }),
      kind: 'escalated',
      text: 'Couldn’t do it here: the fix was stopped. It goes with Send.',
    },
    {
      name: 'its fix was undone',
      note: routedNote('quick'),
      fix: makeQuickFix({ status: 'undone', said: null }),
      kind: 'undone',
      text: 'Undone. It goes to the editor when you send.',
    },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      const line = noteFixLine(c.note, c.fix, { ...LINE_CONTEXT, ...c.context });
      expect(line?.kind).toBe(c.kind);
      expect(line?.text).toBe(c.text);
      expect(line?.tail ?? undefined).toBe(c.tail);
    });
  }

  it('says "Fixed" alone when the fix has no length', () => {
    const line = noteFixLine(routedNote('quick'), makeQuickFix({ durationSec: null }), {
      ...LINE_CONTEXT,
      newestFixedId: 'f1',
    });
    expect(line?.text).toBe('Fixed.');
  });

  it('rounds the length to whole seconds and never says 0', () => {
    const at = (durationSec: number) =>
      noteFixLine(routedNote('quick'), makeQuickFix({ durationSec }), LINE_CONTEXT)?.text;
    expect(at(28.4)).toBe('Fixed in 28 s.');
    expect(at(28.6)).toBe('Fixed in 29 s.');
    expect(at(0.2)).toBe('Fixed in 1 s.');
  });

  it('leaves out a reason’s closing full stop: the line adds its own', () => {
    const line = noteFixLine(
      routedNote('quick'),
      makeQuickFix({ status: 'failed', why: 'it could not run: no time.', said: null }),
      LINE_CONTEXT,
    );
    expect(line?.text).toBe('Couldn’t do it here: it could not run: no time. It goes with Send.');
    const sends = noteFixLine(
      makeReviewNote({
        routeStatus: 'routed',
        route: { tier: 'revise', kind: 'Swapping a shot', why: 'it changes the cut.' },
      }),
      null,
      LINE_CONTEXT,
    );
    expect(sends?.text).toBe('Goes with Send · it changes the cut');
  });

  it('still reads when a fix fails with no reason', () => {
    const line = noteFixLine(
      routedNote('quick'),
      makeQuickFix({ status: 'failed', why: null, said: null }),
      LINE_CONTEXT,
    );
    expect(line?.text).toBe('Couldn’t do it here. It goes with Send.');
  });

  it('has no line for a manual level, a note Auto never read, or a switch that is off', () => {
    // A level: nothing was read, nothing is fixed.
    expect(noteFixLine(makeReviewNote(), null, { ...LINE_CONTEXT, auto: false })).toBeNull();
    // Routed on Auto earlier, a level now: today's card.
    expect(noteFixLine(routedNote('revise'), null, { ...LINE_CONTEXT, auto: false })).toBeNull();
    expect(noteFixLine(reading, null, { ...LINE_CONTEXT, auto: false })).toBeNull();
    // Auto, but the note was never read (from before Quick fixes).
    expect(noteFixLine(makeReviewNote(), null, LINE_CONTEXT)).toBeNull();
  });

  it('keeps the line of a fix that exists even when a level replaced Auto', () => {
    const fixed = noteFixLine(routedNote('quick'), makeQuickFix(), {
      ...LINE_CONTEXT,
      auto: false,
      newestFixedId: 'f1',
    });
    expect(fixed?.kind).toBe('fixed');
    expect(fixed?.undoFixId).toBe('f1');
  });

  it('says a quick note without a fix goes with Send, once the fixes are in', () => {
    const quick = routedNote('quick');
    expect(noteFixLine(quick, null, LINE_CONTEXT)?.text).toBe('Goes with Send');
    // Cancelled fixes never count (activeFixByNote skips them): the same.
    expect(
      noteFixLines([quick], [makeQuickFix({ status: 'cancelled' })], AUTO).get('n1')?.text,
    ).toBe('Goes with Send');
    // Before they are in, its fix may be on its way: nothing is claimed.
    expect(noteFixLine(quick, null, { ...LINE_CONTEXT, loaded: false })).toBeNull();
  });
});

describe('noteFixLine: the bar, Undo and the delete button', () => {
  it('draws the bar at (step + 1) × 25 % while a fix runs, and not otherwise', () => {
    const at = (step: number) =>
      noteFixLine(routedNote('quick'), makeOpenFix('running', { step }), LINE_CONTEXT)?.progress;
    expect([0, 1, 2, 3].map(at)).toEqual([25, 50, 75, 100]);
    // Step 0 is set the moment it starts, but a fix without a step counts as the first.
    expect(
      noteFixLine(routedNote('quick'), makeOpenFix('running', { step: null }), LINE_CONTEXT)
        ?.progress,
    ).toBe(25);
    expect(
      noteFixLine(routedNote('quick'), makeOpenFix('queued'), LINE_CONTEXT)?.progress,
    ).toBeNull();
    expect(
      noteFixLine(routedNote('quick'), makeQuickFix(), { ...LINE_CONTEXT, newestFixedId: 'f1' })
        ?.progress,
    ).toBeNull();
  });

  it('running without a step label says only "Fixing it now"', () => {
    const line = noteFixLine(
      routedNote('quick'),
      makeOpenFix('running', { stepLabel: null }),
      LINE_CONTEXT,
    );
    expect(line?.text).toBe('Fixing it now');
  });

  it('offers Undo on the newest fixed fix only', () => {
    const older = makeQuickFix({ id: 'f1', noteId: 'n1' });
    const newer = makeQuickFix({ id: 'f2', noteId: 'n2', endedAt: '2026-10-25T09:05:00.000Z' });
    const lines = noteFixLines(
      [routedNote('quick', { id: 'n1' }), routedNote('quick', { id: 'n2' })],
      [older, newer],
      AUTO,
    );
    expect(lines.get('n1')?.undoFixId).toBeNull();
    expect(lines.get('n2')?.undoFixId).toBe('f2');
  });

  it('holds Undo back while another fix is queued or running (the server would refuse it)', () => {
    const lines = noteFixLines(
      [routedNote('quick', { id: 'n1' }), routedNote('quick', { id: 'n2' })],
      [
        makeQuickFix({ id: 'f1', noteId: 'n1' }),
        makeOpenFix('running', { id: 'f2', noteId: 'n2' }),
      ],
      AUTO,
    );
    expect(lines.get('n1')?.undoFixId).toBe('f1');
    expect(lines.get('n1')?.undoBlocked).toBe(true);
    const idle = noteFixLines([routedNote('quick')], [makeQuickFix()], AUTO);
    expect(idle.get('n1')?.undoBlocked).toBe(false);
  });

  it('hides the delete button of a fixed note that is not the newest fix, and disables it while its fix runs', () => {
    const lines = noteFixLines(
      [
        routedNote('quick', { id: 'n1' }),
        routedNote('quick', { id: 'n2' }),
        routedNote('quick', { id: 'n3' }),
        routedNote('revise', { id: 'n4' }),
      ],
      [
        makeQuickFix({ id: 'f1', noteId: 'n1' }),
        makeQuickFix({ id: 'f2', noteId: 'n2', endedAt: '2026-10-25T09:05:00.000Z' }),
        makeOpenFix('running', { id: 'f3', noteId: 'n3' }),
      ],
      AUTO,
    );
    expect(lines.get('n1')?.deleteMode).toBe('hidden');
    // The newest fix can be deleted: the server undoes it first.
    expect(lines.get('n2')?.deleteMode).toBe('ok');
    expect(lines.get('n3')?.deleteMode).toBe('disabled');
    expect(lines.get('n4')?.deleteMode).toBe('ok');
  });

  it('gives only the notes that have a line an entry', () => {
    const lines = noteFixLines([makeReviewNote({ id: 'plain' }), routedNote('revise')], [], AUTO);
    expect([...lines.keys()]).toEqual(['n1']);
  });
});

describe('the fixes of a note', () => {
  it('counts the newest fix that was not cancelled', () => {
    const first = makeQuickFix({ id: 'a', status: 'escalated', why: 'x', said: null });
    const second = makeOpenFix('queued', { id: 'b' });
    const cancelled = makeQuickFix({ id: 'c', status: 'cancelled', said: null });
    expect(activeFixByNote([first, second]).get('n1')?.id).toBe('b');
    expect(activeFixByNote([first, cancelled]).get('n1')?.id).toBe('a');
    expect(activeFixByNote([cancelled]).has('n1')).toBe(false);
  });

  it('finds the newest fixed fix by when it ended, then by its place', () => {
    expect(newestFixedId([])).toBeNull();
    expect(newestFixedId([makeOpenFix('queued')])).toBeNull();
    const a = makeQuickFix({ id: 'a', endedAt: '2026-10-25T09:10:00.000Z' });
    const b = makeQuickFix({ id: 'b', endedAt: '2026-10-25T09:00:00.000Z' });
    // The rows are in queue order; the last to end is the newest.
    expect(newestFixedId([a, b])).toBe('a');
    expect(newestFixedId([b, a])).toBe('a');
    const tie = makeQuickFix({ id: 'c', endedAt: '2026-10-25T09:10:00.000Z' });
    expect(newestFixedId([a, tie])).toBe('c');
    // An undone fix is not fixed.
    expect(newestFixedId([makeQuickFix({ id: 'u', status: 'undone' })])).toBeNull();
  });

  it('is busy while a fix is queued or running', () => {
    expect(fixIsBusy([])).toBe(false);
    expect(fixIsBusy([makeQuickFix()])).toBe(false);
    expect(fixIsBusy([makeQuickFix(), makeOpenFix('queued')])).toBe(true);
    expect(fixIsBusy([makeOpenFix('running')])).toBe(true);
  });
});

describe('fixNoteState', () => {
  it('puts a note where its fix and its route say', () => {
    const states = (note: ReviewNote, fix: QuickFix | null, context = AUTO) =>
      fixNoteState(note, fix, context);
    expect(states(reading, null)).toBe('reading');
    expect(states(routedNote('quick'), makeOpenFix('queued'))).toBe('queued');
    expect(states(routedNote('quick'), makeOpenFix('running'))).toBe('running');
    expect(states(routedNote('quick'), makeQuickFix())).toBe('fixed');
    expect(states(routedNote('revise'), null)).toBe('waiting');
    expect(states(routedNote('quick'), makeQuickFix({ status: 'undone' }))).toBe('waiting');
    expect(states(routedNote('quick'), makeQuickFix({ status: 'escalated' }))).toBe('waiting');
    expect(states(routedNote('quick'), makeQuickFix({ status: 'failed' }))).toBe('waiting');
    expect(states(routedNote('quick'), null)).toBe('waiting');
    // Not read yet is only a state of Auto.
    expect(states(reading, null, LEVEL)).toBe('waiting');
  });

  it('holds a quick note whose fix is not known yet, until the fixes are in', () => {
    expect(fixNoteState(routedNote('quick'), null, { auto: true, loaded: false })).toBe('reading');
    expect(fixNoteState(routedNote('revise'), null, { auto: true, loaded: false })).toBe('waiting');
  });
});

describe('waitingNotes and the tier they run at', () => {
  it('counts the notes that wait for Send, the fixed ones and the ones being worked on aside', () => {
    const notes = [
      routedNote('quick', { id: 'a' }),
      routedNote('quick', { id: 'b' }),
      routedNote('revise', { id: 'c' }),
      routedNote('quick', { id: 'd' }),
      reading,
    ];
    const fixes = [
      makeQuickFix({ id: 'fa', noteId: 'a' }),
      makeQuickFix({ id: 'fb', noteId: 'b', status: 'undone' }),
      makeOpenFix('running', { id: 'fd', noteId: 'd' }),
    ];
    expect(waitingNotes(notes, fixes, AUTO).map((note) => note.id)).toEqual(['b', 'c']);
  });

  it('runs a waiting quick note as revise, a full note or one Auto never read as full', () => {
    expect(waitingTier([routedNote('quick')])).toBe('revise');
    expect(waitingTier([routedNote('revise'), routedNote('quick')])).toBe('revise');
    expect(waitingTier([routedNote('revise'), routedNote('full')])).toBe('full');
    expect(waitingTier([makeReviewNote()])).toBe('full');
  });

  it('names who runs a tier: the tier’s model, or the editor when the configured one is not known', () => {
    expect(tierRunName('revise')).toBe('Sonnet at High');
    expect(tierRunName('full')).toBe('the editor at Extra high');
    expect(modelName('opus')).toBe('Opus');
    expect(modelName(null)).toBe('the editor');
  });
});

describe('fill', () => {
  it('replaces each {name} and leaves one it has no value for', () => {
    expect(fill('Fixed in {n} s.', { n: 38 })).toBe('Fixed in 38 s.');
    expect(fill('{a} and {a} and {b}', { a: 'x' })).toBe('x and x and {b}');
  });
});

describe('startsRtl', () => {
  it('is true for text whose first letter is Hebrew or Arabic, as dir="auto" decides', () => {
    expect(startsRtl('הכיתוב בשנייה 25.6 הוא עכשיו "יש סיפור משלו".')).toBe(true);
    expect(startsRtl('הכתוביות צהובות עכשיו.')).toBe(true);
    expect(startsRtl('تم تغيير الخط.')).toBe(true);
  });

  it('skips digits, quotes and punctuation before the first letter', () => {
    expect(startsRtl('"יש סיפור משלו" הוא הכיתוב עכשיו.')).toBe(true);
    expect(startsRtl('25.6 שניות בלבד.')).toBe(true);
    expect(startsRtl('(שלום) hello')).toBe(true);
  });

  it('is false for text whose first letter is Latin, even when it has Hebrew in it', () => {
    expect(startsRtl('The captions are Heebo Bold now.')).toBe(false);
    expect(startsRtl('The title “יש סיפור משלו” is bigger now.')).toBe(false);
    expect(startsRtl('0:34 is removed.')).toBe(false);
  });

  it('is false for text with no letter', () => {
    expect(startsRtl('')).toBe(false);
    expect(startsRtl('25.6 …')).toBe(false);
  });
});

describe('fixFooter: one line and one action for each case', () => {
  const base = { writing: false, submitting: null, sendDisabledReason: null };
  const footer = (
    notes: readonly ReviewNote[] | undefined,
    fixes: readonly QuickFix[] = [],
    context: FixContext = AUTO,
  ) => fixFooter({ ...base, notes, fixes, ...context });

  const fixedNote = (id: string, extra: Partial<ReviewNote> = {}) =>
    routedNote('quick', { id, fixId: `f-${id}`, ...extra });
  const fixedFix = (id: string) => makeQuickFix({ id: `f-${id}`, noteId: id });

  const table: {
    name: string;
    notes: ReviewNote[];
    fixes?: QuickFix[];
    context?: FixContext;
    action: 'send_notes' | 'approve';
    label: string;
    text: string;
    off?: boolean;
    quickFix?: 'busy' | 'fixed' | 'auto';
  }[] = [
    {
      name: 'no notes: today’s text',
      notes: [],
      action: 'approve',
      label: 'Approve',
      text: FOOTER_TEXT.withoutNotes,
    },
    {
      name: 'a note being read',
      notes: [reading],
      action: 'approve',
      label: 'Approve',
      text: 'Reading the note. Approve waits for it.',
      off: true,
      quickFix: 'busy',
    },
    {
      name: 'a note being read next to one that waits for Send',
      notes: [reading, routedNote('revise', { id: 'w' })],
      action: 'send_notes',
      label: 'Send 1 note',
      text: 'Reading the note. Send waits for it.',
      off: true,
      quickFix: 'busy',
    },
    {
      name: 'a fix queued',
      notes: [routedNote('quick')],
      fixes: [makeOpenFix('queued')],
      action: 'approve',
      label: 'Approve',
      text: 'Fixing it here. Approve waits for it.',
      off: true,
      quickFix: 'busy',
    },
    {
      name: 'a fix running, with a note that waits for Send',
      notes: [routedNote('quick'), routedNote('revise', { id: 'w' })],
      fixes: [makeOpenFix('running')],
      action: 'send_notes',
      label: 'Send 1 note',
      text: 'Fixing it here. Send waits for it.',
      off: true,
      quickFix: 'busy',
    },
    {
      name: 'two fixes under way',
      notes: [routedNote('quick', { id: 'a' }), routedNote('quick', { id: 'b' })],
      fixes: [
        makeOpenFix('running', { id: 'fa', noteId: 'a' }),
        makeOpenFix('queued', { id: 'fb', noteId: 'b' }),
      ],
      action: 'approve',
      label: 'Approve',
      text: 'Fixing 2 notes here, one at a time. Approve waits for it.',
      off: true,
      quickFix: 'busy',
    },
    {
      name: 'a fix running next to a fixed note',
      notes: [fixedNote('a'), routedNote('quick', { id: 'b' })],
      fixes: [fixedFix('a'), makeOpenFix('running', { id: 'fb', noteId: 'b' })],
      action: 'approve',
      label: 'Approve',
      text: 'Fixing it here. Approve waits for it.',
      off: true,
      quickFix: 'busy',
    },
    {
      name: 'one note that waits, on Auto (a revise note)',
      notes: [routedNote('revise')],
      action: 'send_notes',
      label: 'Send 1 note',
      text: 'Auto sends 1 note to Sonnet at High, 2 to 10 min.',
      quickFix: 'auto',
    },
    {
      name: 'two notes that wait, on Auto, one of them quick but not fixed',
      notes: [routedNote('revise', { id: 'a' }), routedNote('quick', { id: 'b' })],
      fixes: [makeQuickFix({ id: 'fb', noteId: 'b', status: 'escalated', why: 'x', said: null })],
      action: 'send_notes',
      label: 'Send 2 notes',
      text: 'Auto sends 2 notes to Sonnet at High, 2 to 10 min.',
      quickFix: 'auto',
    },
    {
      name: 'a note that waits and a full one, on Auto',
      notes: [routedNote('revise', { id: 'a' }), routedNote('full', { id: 'b' })],
      action: 'send_notes',
      label: 'Send 2 notes',
      text: 'Auto sends 2 notes to the editor at Extra high (one changes the whole video), 4 to 40 min.',
      quickFix: 'auto',
    },
    {
      name: 'a fixed note and a waiting one count only the waiting one',
      notes: [fixedNote('a'), routedNote('revise', { id: 'b' })],
      fixes: [fixedFix('a')],
      action: 'send_notes',
      label: 'Send 1 note',
      text: 'Auto sends 1 note to Sonnet at High, 2 to 10 min.',
      quickFix: 'auto',
    },
    {
      name: 'waiting notes on a level that is not named: today’s text',
      notes: [makeReviewNote({ id: 'a' }), makeReviewNote({ id: 'b' })],
      context: LEVEL,
      action: 'send_notes',
      label: 'Send 2 notes',
      text: FOOTER_TEXT.withNotes,
    },
    {
      name: 'one fixed note',
      notes: [fixedNote('a')],
      fixes: [fixedFix('a')],
      action: 'approve',
      label: 'Approve',
      text: 'Fixed here. Approve it from the job’s right-click menu to render the final video, or keep writing notes.',
      quickFix: 'fixed',
    },
    {
      name: 'three fixed notes',
      notes: [fixedNote('a'), fixedNote('b'), fixedNote('c')],
      fixes: [fixedFix('a'), fixedFix('b'), fixedFix('c')],
      action: 'approve',
      label: 'Approve',
      text: 'All 3 fixed here. Approve it from the job’s right-click menu to render the final video.',
      quickFix: 'fixed',
    },
    {
      name: 'a fix that was undone waits for Send again',
      notes: [routedNote('quick')],
      fixes: [makeQuickFix({ status: 'undone', said: null })],
      action: 'send_notes',
      label: 'Send 1 note',
      text: 'Auto sends 1 note to Sonnet at High, 2 to 10 min.',
      quickFix: 'auto',
    },
    {
      name: 'only fixed notes on a level (the fix landed before the level was chosen)',
      notes: [fixedNote('a')],
      fixes: [fixedFix('a')],
      context: LEVEL,
      action: 'approve',
      label: 'Approve',
      text: 'Fixed here. Approve it from the job’s right-click menu to render the final video, or keep writing notes.',
      quickFix: 'fixed',
    },
  ];

  for (const c of table) {
    it(c.name, () => {
      const view = footer(c.notes, c.fixes, c.context);
      expect(view.action).toBe(c.action);
      expect(view.label).toBe(c.label);
      expect(view.text).toBe(c.text);
      expect(view.disabled).toBe(c.off === true);
      expect(view.disabledReason).toBe(c.off === true ? 'Wait for the fix to finish' : null);
      expect(view.effortDisabled === true).toBe(c.off === true);
      expect(view.quickFix).toBe(c.quickFix);
    });
  }

  it('names the level on a level instead of Auto: "…together, at Extra high."', () => {
    const notes = [makeReviewNote({ id: 'a' }), makeReviewNote({ id: 'b' })];
    for (const [level, words] of [
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
    ] as const) {
      const view = fixFooter({ ...base, notes, fixes: [], ...LEVEL, level });
      expect(view.text).toBe(`Your notes go to the editor together, at ${words}.`);
      expect(view).toMatchObject({ action: 'send_notes', label: 'Send 2 notes', disabled: false });
    }
    // On Auto the level is not asked for: the plan is.
    expect(
      fixFooter({ ...base, notes: [routedNote('revise')], fixes: [], ...AUTO, level: null }).text,
    ).toBe('Auto sends 1 note to Sonnet at High, 2 to 10 min.');
  });

  it('is today’s footer while the notes load', () => {
    expect(footer(undefined)).toEqual(reviewFooter({ ...base, notes: undefined }));
  });

  it('keeps what Send waits for besides fixes (a voice note’s transcript) and a Send on its way', () => {
    const view = fixFooter({
      ...base,
      notes: [routedNote('revise')],
      fixes: [],
      sendDisabledReason: 'Waiting for the voice notes to be transcribed',
      ...AUTO,
    });
    expect(view.disabled).toBe(true);
    expect(view.disabledReason).toBe('Waiting for the voice notes to be transcribed');
    expect(view.effortDisabled).toBeUndefined();
    const sending = fixFooter({
      ...base,
      submitting: 'send_notes',
      notes: [routedNote('revise')],
      fixes: [],
      ...AUTO,
    });
    expect(sending.busy).toBe(true);
    expect(sending.disabled).toBe(true);
  });

  it('keeps Approve off while a note is being written', () => {
    const view = fixFooter({
      ...base,
      writing: true,
      notes: [fixedNote('a')],
      fixes: [fixedFix('a')],
      ...AUTO,
    });
    expect(view.action).toBe('approve');
    expect(view.disabled).toBe(true);
    expect(view.disabledReason).toBeNull();
    expect(view.text).toBe(FIX_TEXT.fixedOne);
  });

  it('does not tell Send from Approve before the fixes are in: a quick note may already have one', () => {
    const view = footer([routedNote('quick')], [], { auto: true, loaded: false });
    expect(view.quickFix).toBe('busy');
    expect(view.text).toBe('Reading the note. Approve waits for it.');
  });
});

describe('minutesText', () => {
  it('is the shortest to the longest in whole minutes', () => {
    expect(minutesText({ min: 12, max: 40 })).toBe('12 to 40 min');
    expect(minutesText({ min: 1, max: 2 })).toBe('1 to 2 min');
  });

  it('is "about N min" when the two are the same', () => {
    expect(minutesText({ min: 5, max: 5 })).toBe('about 5 min');
    expect(minutesText({ min: 1, max: 1 })).toBe('about 1 min');
  });
});

describe('fixFooter: the time of the plan on Auto (C61)', () => {
  const base = { writing: false, submitting: null, sendDisabledReason: null, fixes: [] };
  const text = (notes: ReviewNote[], extra: Parameters<typeof fixFooter>[0]['reviseMinutes']) =>
    fixFooter({ ...base, notes, ...AUTO, reviseMinutes: extra }).text;

  it('says the range of the job’s own earlier revise runs, for either tier', () => {
    const own = { min: 12, max: 40 };
    expect(text([routedNote('revise')], own)).toBe(
      'Auto sends 1 note to Sonnet at High, 12 to 40 min.',
    );
    expect(text([routedNote('revise'), routedNote('full')], own)).toBe(
      'Auto sends 2 notes to the editor at Extra high (one changes the whole video), 12 to 40 min.',
    );
  });

  it('says the tier’s range when the job has none of its own: left out or null', () => {
    const revise = TIER_MINUTES.revise;
    const full = TIER_MINUTES.full;
    expect(text([routedNote('revise')], null)).toBe(
      `Auto sends 1 note to Sonnet at High, ${revise.min} to ${revise.max} min.`,
    );
    expect(text([routedNote('full')], undefined)).toBe(
      `Auto sends 1 note to the editor at Extra high (one changes the whole video), ${full.min} to ${full.max} min.`,
    );
  });

  it('says "about N min" when the job’s shortest and longest are the same', () => {
    expect(text([routedNote('revise')], { min: 3, max: 3 })).toBe(
      'Auto sends 1 note to Sonnet at High, about 3 min.',
    );
  });

  it('keeps a level’s words as they were, whatever the job’s history says', () => {
    const view = fixFooter({
      ...base,
      notes: [routedNote('revise')],
      ...LEVEL,
      level: 'high',
      reviseMinutes: { min: 12, max: 40 },
    });
    expect(view.text).toBe('Your notes go to the editor together, at High.');
  });
});
