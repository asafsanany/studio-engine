import { type GenerateNotePlan, type JobFormat, jobFormatsOf } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeGenerateState, makeReviewNote } from '@/data/test-utils';
import type { FooterView } from '../notes-logic';
import { REVIEW_DIALOG_TEXT } from '../review-text';
import {
  exportWords,
  formatStamp,
  formatsFooter,
  formatsOf,
  formatsRenderText,
  markerNotes,
  noteFormat,
  noteFormatLabel,
  noteMarksOf,
  selectedFormat,
} from './format-logic';

const FORMATS = jobFormatsOf(['1080x1920', '1080x1080']);
const [MAIN, SQUARE] = FORMATS as [JobFormat, JobFormat];

const PLAN: GenerateNotePlan = {
  clips: [
    { id: 'A', usd: 0.36, windows: [{ startSec: 0, endSec: 3 }] },
    { id: 'B', usd: 0.51, windows: [{ startSec: 3, endSec: 8 }] },
  ],
  lines: [
    { id: 'L1', startSec: 3, endSec: 6.6 },
    { id: 'L2', startSec: 6.6, endSec: 10 },
  ],
};

// The board's three notes: a hand in clip B, a stressed word, and an end card on 1:1.
const HAND = makeReviewNote({
  id: 'n1',
  atSec: 4.2,
  text: 'Their left hand bends oddly while he pours.',
});
const STRESS = makeReviewNote({
  id: 'n2',
  atSec: 7,
  text: 'Stress the BUT more, with a real pause after it.',
});
const END_CARD = makeReviewNote({
  id: 'n3',
  atSec: 32,
  text: 'End card: logo bigger, the button lower.',
  format: '1x1',
});
const NOTES = [HAND, STRESS, END_CARD];

describe('the formats of a job', () => {
  it('are only there with two or more', () => {
    expect(formatsOf({ formats: FORMATS })).toEqual(FORMATS);
    expect(formatsOf({})).toBeUndefined();
    expect(formatsOf({ formats: FORMATS.slice(0, 1) })).toBeUndefined();
  });

  it('pick the main one for an unknown id', () => {
    expect(selectedFormat(FORMATS, null)).toBe(MAIN);
    expect(selectedFormat(FORMATS, '1x1')).toBe(SQUARE);
    expect(selectedFormat(FORMATS, '4x5')).toBe(MAIN);
  });

  it('stamp a note with the id of an extra format and null for the main one', () => {
    expect(formatStamp(FORMATS, MAIN)).toBeNull();
    expect(formatStamp(FORMATS, SQUARE)).toBe('1x1');
  });

  it('give a note its format: null, nothing and a format the job lost are the main one', () => {
    expect(noteFormat(END_CARD, FORMATS)).toBe(SQUARE);
    expect(noteFormat(HAND, FORMATS)).toBe(MAIN);
    expect(noteFormat({}, FORMATS)).toBe(MAIN);
    expect(noteFormat({ format: '4x5' }, FORMATS)).toBe(MAIN);
  });

  it('print a label after the time only for an extra format', () => {
    expect(noteFormatLabel(END_CARD, FORMATS)).toBe('1:1');
    expect(noteFormatLabel(HAND, FORMATS)).toBeNull();
  });
});

describe('noteMarksOf on a generated job with two formats', () => {
  const generate = { spendUsd: 2.33, budgetUsd: 3 };
  const marks = noteMarksOf({ notes: NOTES, formats: FORMATS, plan: PLAN, generate });

  it('says what Send will probably do with each note, as the board does', () => {
    expect(marks.marks.get('n1')).toEqual({
      formatLabel: null,
      hint: { tone: 'amber', text: 'New take of clip B on Send · about $0.51 · both formats' },
    });
    expect(marks.marks.get('n2')?.hint).toEqual({
      tone: 'blue',
      text: 'Remakes voice line 2 on Send · ElevenLabs, nothing spent on Higgsfield · both formats',
    });
    expect(marks.marks.get('n3')).toEqual({
      formatLabel: '1:1',
      hint: { tone: 'muted', text: 'Edit change · 1:1 only' },
    });
  });

  it('adds up the new takes', () => {
    expect(marks.takesUsd).toBe(0.51);
  });

  it('keeps a size or position note to its own format and the rest to both', () => {
    expect([...marks.scopes]).toEqual([
      ['n1', 'both'],
      ['n2', 'both'],
      ['n3', 'own'],
    ]);
  });

  it('draws the phone’s line with what is left of the budget', () => {
    const phone = noteMarksOf({
      notes: NOTES,
      formats: FORMATS,
      plan: PLAN,
      generate,
      where: 'phone',
    });
    expect(phone.marks.get('n1')?.hint?.text).toBe(
      'New take of clip B on Send · about $0.51 · $0.67 left of the $3',
    );
  });

  it('counts two notes about one clip as one take', () => {
    const twice = noteMarksOf({
      notes: [HAND, makeReviewNote({ id: 'n4', atSec: 5, text: 'The pole looks bent' })],
      formats: FORMATS,
      plan: PLAN,
      generate,
    });
    expect(twice.takesUsd).toBe(0.51);
  });
});

describe('noteMarksOf elsewhere', () => {
  it('draws no hint without a plan, and no sum', () => {
    for (const plan of [null, undefined]) {
      const none = noteMarksOf({
        notes: NOTES,
        formats: FORMATS,
        plan,
        generate: makeGenerateState(),
      });
      expect(none.takesUsd).toBeNull();
      expect([...none.marks.values()].every((mark) => mark.hint === null)).toBe(true);
    }
  });

  it('draws no hint for a job that is not generated, but still stamps the format', () => {
    const marks = noteMarksOf({ notes: NOTES, formats: FORMATS, plan: PLAN, generate: undefined });
    expect(marks.marks.get('n3')).toEqual({ formatLabel: '1:1', hint: null });
    expect(marks.marks.has('n1')).toBe(false);
    expect(marks.takesUsd).toBeNull();
    // A layout word still keeps a change to one format.
    expect(marks.scopes.get('n3')).toBe('own');
  });

  it('draws no format on a job with one format, and the hint has no "both formats"', () => {
    const marks = noteMarksOf({
      notes: [HAND, STRESS],
      formats: undefined,
      plan: PLAN,
      generate: { spendUsd: 0, budgetUsd: 3 },
    });
    expect(marks.marks.get('n1')).toEqual({
      formatLabel: null,
      hint: { tone: 'amber', text: 'New take of clip B on Send · about $0.51' },
    });
  });

  it('leaves a voice note with no transcript yet without a hint', () => {
    const voice = makeReviewNote({
      id: 'v1',
      kind: 'voice',
      text: null,
      transcriptStatus: 'pending',
      audioFile: 'a.webm',
      audioSec: 3,
    });
    const marks = noteMarksOf({
      notes: [voice],
      formats: FORMATS,
      plan: PLAN,
      generate: { spendUsd: 0, budgetUsd: 3 },
    });
    expect(marks.marks.has('v1')).toBe(false);
    expect(marks.scopes.get('v1')).toBe('both');
  });

  it('has nothing for no notes', () => {
    const marks = noteMarksOf({
      notes: undefined,
      formats: FORMATS,
      plan: PLAN,
      generate: undefined,
    });
    expect(marks.marks.size).toBe(0);
    expect(marks.takesUsd).toBeNull();
  });
});

describe('markerNotes', () => {
  const scopes = new Map<string, 'both' | 'own'>([
    ['n1', 'both'],
    ['n2', 'both'],
    ['n3', 'own'],
  ]);
  const only = (shown: JobFormat) =>
    markerNotes(NOTES, FORMATS, shown, scopes).map((note) => note.id);

  it('marks the notes of the shown format and the notes that apply to both', () => {
    expect(only(MAIN)).toEqual(['n1', 'n2']);
    expect(only(SQUARE)).toEqual(['n1', 'n2', 'n3']);
  });

  it('hides a size note of the other format', () => {
    const own = new Map<string, 'both' | 'own'>([['n1', 'own']]);
    expect(markerNotes([HAND], FORMATS, SQUARE, own)).toEqual([]);
    expect(markerNotes([HAND], FORMATS, MAIN, own)).toEqual([HAND]);
  });

  it('marks every note of a job with one format', () => {
    expect(markerNotes(NOTES, undefined, undefined, scopes)).toBe(NOTES);
    expect(markerNotes(undefined, FORMATS, MAIN, scopes)).toEqual([]);
  });
});

describe('formatsFooter', () => {
  const approve: FooterView = {
    action: 'approve',
    text: 'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    label: 'Approve',
    disabled: false,
    busy: false,
    disabledReason: null,
  };
  const send: FooterView = {
    action: 'send_notes',
    text: 'Your notes go to the editor together.',
    label: 'Send 3 notes',
    disabled: false,
    busy: false,
    disabledReason: null,
  };
  const generate = { spendUsd: 2.33, budgetUsd: 3 };

  it('says Approve renders both formats', () => {
    expect(
      formatsFooter(approve, {
        formats: FORMATS,
        sendCount: 0,
        takesUsd: null,
        generate: undefined,
      }).text,
    ).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render both formats, 9:16 and 1:1.',
    );
  });

  it('keeps the end of the music’s line', () => {
    const music = {
      ...approve,
      text: 'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v2.',
    };
    expect(
      formatsFooter(music, { formats: FORMATS, sendCount: 0, takesUsd: null, generate: undefined })
        .text,
    ).toBe(
      'Happy with it? Approve it from the job’s right-click menu to render both formats, 9:16 and 1:1, with music v2.',
    );
  });

  it('leaves another Approve line, and a job with one format, alone', () => {
    const waiting = { ...approve, text: 'Music v2 is still being made. Approve when it is ready.' };
    const input = { formats: FORMATS, sendCount: 0, takesUsd: null, generate: undefined };
    expect(formatsFooter(waiting, input)).toBe(waiting);
    expect(formatsFooter(approve, { ...input, formats: undefined })).toBe(approve);
  });

  it('adds up the new takes against what is left of the budget on Send', () => {
    const input = { formats: FORMATS, sendCount: 3, takesUsd: 0.51, generate };
    expect(formatsFooter(send, input).text).toBe(
      '3 notes. New takes use about $0.51 of the $0.67 left of the $3.',
    );
    expect(formatsFooter(send, { ...input, takesUsd: 1.2 }).text).toBe(
      '3 notes. New takes need about $1.20, more than the $0.67 left of the $3: the worst one goes first.',
    );
    expect(formatsFooter(send, { ...input, takesUsd: 0, sendCount: 1 }).text).toBe(
      '1 note. No new takes, so nothing spent on Higgsfield.',
    );
  });

  it('puts the money after Quick fixes’ own line', () => {
    const quick: FooterView = {
      ...send,
      text: 'Auto sends 2 notes to Sonnet at High.',
      quickFix: 'auto',
    };
    expect(
      formatsFooter(quick, { formats: undefined, sendCount: 2, takesUsd: 0.51, generate }).text,
    ).toBe(
      'Auto sends 2 notes to Sonnet at High. New takes use about $0.51 of the $0.67 left of the $3.',
    );
  });

  it('leaves Send alone on a job that is not generated', () => {
    expect(
      formatsFooter(send, { formats: FORMATS, sendCount: 3, takesUsd: null, generate: undefined }),
    ).toBe(send);
  });

  it('names all the formats when there are more than two', () => {
    const three = jobFormatsOf(['1080x1920', '1080x1080', '1080x1350']) as JobFormat[];
    expect(formatsRenderText(three)).toBe('all 3 formats, 9:16, 1:1 and 4:5');
    expect(formatsRenderText(FORMATS)).toBe('both formats, 9:16 and 1:1');
  });
});

describe('exportWords (Export MP4, C65)', () => {
  it('are the words it always had on a job with one format', () => {
    expect(exportWords(undefined)).toEqual({
      mp4: 'Export MP4',
      save: 'Save MP4',
      tip: REVIEW_DIALOG_TEXT.exportTip,
      readyTip: REVIEW_DIALOG_TEXT.exportReadyTip,
    });
  });

  it('say the size on a job with two formats, for the main one and the extra one', () => {
    expect(exportWords(MAIN)).toMatchObject({ mp4: 'Export MP4 · 9:16', save: 'Save MP4 · 9:16' });
    expect(exportWords(SQUARE)).toMatchObject({ mp4: 'Export MP4 · 1:1', save: 'Save MP4 · 1:1' });
  });

  it('say in the tooltip which size it renders, that the other has its own export, and not that Approve reuses it', () => {
    const words = exportWords(SQUARE);
    expect(words.tip).toBe(
      'Renders the full-quality 1:1 video now. The other size has an export of its own.',
    );
    expect(words.readyTip).toContain('1:1 video is ready to save');
    expect(`${words.tip} ${words.readyTip}`).not.toMatch(/Approving/);
  });
});
