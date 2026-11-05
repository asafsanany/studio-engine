import { describe, expect, it } from 'vitest';
import {
  type GenerateNotePlan,
  generateNoteHint,
  generateNotePlanSchema,
  newTakesCostUsd,
  newTakesSentence,
  noteHintLine,
  noteMentionsClip,
  noteMentionsLayout,
  noteMentionsVoice,
} from './generate-note-hint.ts';

// The PINEWOOD shape: a hook clip, the homeowner, the skylight three times, the technician; a $97 card and
// the end card that are not clips; seven voice lines.
const PLAN: GenerateNotePlan = {
  clips: [
    {
      id: 'A',
      usd: 0.36,
      windows: [
        { startSec: 0, endSec: 3 },
        { startSec: 8, endSec: 10.2 },
      ],
    },
    { id: 'B', usd: 0.51, windows: [{ startSec: 3, endSec: 8 }] },
    { id: 'C', usd: 0.18, windows: [{ startSec: 10.2, endSec: 11.8 }] },
    { id: 'D', usd: 0.34, windows: [{ startSec: 16.5, endSec: 20.5 }] },
  ],
  lines: [
    { id: 'L1', startSec: 3, endSec: 6.6 },
    { id: 'L2', startSec: 6.6, endSec: 10.2 },
    { id: 'L3', startSec: 10.2, endSec: 11.8 },
  ],
};

describe('the word lists', () => {
  it('match whole words with their endings, never inside another word', () => {
    for (const text of [
      'His left hand bends oddly',
      'the hands are wrong',
      'the pole looks bent',
      'water everywhere',
      'it is melting',
      'THE LOGO is warped',
      'a weird glitch',
    ]) {
      expect(noteMentionsClip(text), text).toBe(true);
    }
    for (const text of ['the handle is fine', 'a sofa', 'sharp edges', 'watermark text', '']) {
      expect(noteMentionsClip(text), text).toBe(false);
    }
    // "watermark" is not "water" + an ending: the word runs on.
  });

  it('know the voice words', () => {
    for (const text of [
      'Stress the BUT more',
      'a real pause after it',
      'the narrator sounds flat',
      'say it louder',
      'make his tone warmer',
      'the way he says it is flat',
      'he reads that line too fast',
      'the voice is too fast',
      'it reads wrong',
    ]) {
      expect(noteMentionsVoice(text), text).toBe(true);
    }
    for (const text of ['the video is ready', 'already', 'essay', 'make the logo bigger']) {
      expect(noteMentionsVoice(text), text).toBe(false);
    }
  });

  it('leave notes about captions, cards and music to the edit (C68)', () => {
    // Words that are common in these notes (read, say, tone, left, right, place) are not enough to
    // send a note to a new take or a new voice line, which cost time and money.
    for (const text of [
      'the caption is hard to read',
      'the words on the card are too small to read',
      'the caption should say ninety-seven dollars',
      'change the tone of the card to a darker blue',
      'move the end card lower',
      'make the button bigger',
      'louder music',
      'make the music quieter after the second alert',
      'the alert sound is too loud',
      'place the badge at the top',
      'the badge is on the right',
    ]) {
      expect(noteMentionsVoice(text), text).toBe(false);
      expect(noteMentionsClip(text), text).toBe(false);
    }
    // Hint: the same notes are plain edits (no spend), on any clip on screen.
    expect(generateNoteHint('the caption is hard to read', 4_200, PLAN)).toMatchObject({
      kind: 'edit',
    });
  });

  it('still catch the notes that are about a clip or the voice (C68)', () => {
    for (const text of [
      'his left hand bends oddly',
      'the water looks fake',
      'the pole is warped',
    ]) {
      expect(noteMentionsClip(text), text).toBe(true);
    }
    for (const text of [
      'stress the BUT more',
      'slower, with a pause after it',
      'the narrator is too quiet',
      'say it louder',
      'say that with more weight',
      'the way he says nobody is too soft',
      'louder voice on the offer',
    ]) {
      expect(noteMentionsVoice(text), text).toBe(true);
    }
  });

  it('know a position said as a phrase (C68)', () => {
    for (const text of ['put it to the left', 'on the right side', 'the badge on the left']) {
      expect(noteMentionsLayout(text), text).toBe(true);
    }
    for (const text of ['his left hand', 'that is not right', 'the right amount']) {
      expect(noteMentionsLayout(text), text).toBe(false);
    }
  });

  it('know the layout words', () => {
    for (const text of ['logo bigger', 'move the button', 'lower the captions', 'crop it']) {
      expect(noteMentionsLayout(text), text).toBe(true);
    }
    expect(noteMentionsLayout('change the music')).toBe(false);
  });

  it('know the Hebrew words, with the letters Hebrew glues on', () => {
    expect(noteMentionsClip('היד נראית עקומה')).toBe(true);
    expect(noteMentionsClip('הידיים מוזרות')).toBe(true);
    expect(noteMentionsClip('ידוע שזה טוב')).toBe(false);
    expect(noteMentionsVoice('הקריין צריך להדגיש')).toBe(true);
    expect(noteMentionsVoice('הקול חלש')).toBe(true);
    expect(noteMentionsLayout('הלוגו גדול מדי')).toBe(true);
  });
});

describe('generateNoteHint', () => {
  it('is a new take of the clip on screen when the note names something in a clip', () => {
    expect(generateNoteHint('His left hand bends oddly while he pours.', 4_200, PLAN)).toEqual({
      kind: 'clip',
      clipId: 'B',
      costUsd: 0.51,
      formatScope: 'both',
    });
  });

  it('finds a clip that is used more than once by any of its windows', () => {
    expect(generateNoteHint('the skylight looks warped', 9_000, PLAN)).toMatchObject({
      kind: 'clip',
      clipId: 'A',
    });
    expect(generateNoteHint('the skylight looks warped', 1_000, PLAN)).toMatchObject({
      clipId: 'A',
    });
  });

  it('is not a clip note over a card: the words fall through to the next rule', () => {
    // 12.0 s to 16.5 s is no clip of the plan (a card or text on screen).
    expect(generateNoteHint('the logo is wrong', 13_000, PLAN)).toEqual({
      kind: 'edit',
      formatScope: 'both',
    });
  });

  it('is the voice line spoken at the moment, and costs nothing on Higgsfield', () => {
    expect(
      generateNoteHint('Stress the BUT more, with a real pause after it.', 7_000, PLAN),
    ).toEqual({ kind: 'voice', lineId: 'L2', costUsd: 0, formatScope: 'both' });
  });

  it('takes the first line before it starts and the last after it ends', () => {
    expect(generateNoteHint('say it louder', 500, PLAN)).toMatchObject({ lineId: 'L1' });
    expect(generateNoteHint('say it louder', 40_000, PLAN)).toMatchObject({ lineId: 'L3' });
  });

  it('puts clip words before voice words', () => {
    expect(generateNoteHint('the narrator holds a weird hand', 4_000, PLAN).kind).toBe('clip');
  });

  it('is an edit change in every format by default, and in one format for a layout word', () => {
    expect(generateNoteHint('Cut this shot a bit earlier', 5_000, PLAN)).toEqual({
      kind: 'edit',
      formatScope: 'both',
    });
    expect(generateNoteHint('End card: logo bigger, the button lower.', 32_000, PLAN)).toEqual({
      kind: 'edit',
      formatScope: 'own',
    });
  });

  it('gives a voice hint with no line when the plan has none', () => {
    expect(generateNoteHint('say it louder', 1_000, { clips: [], lines: [] })).toEqual({
      kind: 'voice',
      costUsd: 0,
      formatScope: 'both',
    });
  });
});

describe('newTakesCostUsd', () => {
  it('adds one take of each clip, however many notes name it', () => {
    const hints = [
      generateNoteHint('hand is wrong', 4_000, PLAN),
      generateNoteHint('the pole is bent', 5_000, PLAN),
      generateNoteHint('the face is odd', 11_000, PLAN),
      generateNoteHint('say it louder', 7_000, PLAN),
      generateNoteHint('cut earlier', 2_000, PLAN),
    ];
    expect(newTakesCostUsd(hints)).toBe(0.69);
  });

  it('is 0 with no clip note', () => {
    expect(newTakesCostUsd([])).toBe(0);
  });
});

describe('the words', () => {
  const two = { formats: { ownLabel: '1:1' } };

  it('says a new take with its clip, its price and the formats', () => {
    expect(noteHintLine(generateNoteHint('hand', 4_000, PLAN), two)).toEqual({
      tone: 'amber',
      text: 'New take of clip B on Send · about $0.51 · both formats',
    });
  });

  it('leaves the formats out of a job with one', () => {
    expect(noteHintLine(generateNoteHint('hand', 4_000, PLAN)).text).toBe(
      'New take of clip B on Send · about $0.51',
    );
  });

  it('says the voice line is remade by ElevenLabs', () => {
    expect(noteHintLine(generateNoteHint('say it louder', 7_000, PLAN), two)).toEqual({
      tone: 'blue',
      text: 'Remakes voice line 2 on Send · ElevenLabs, nothing spent on Higgsfield · both formats',
    });
  });

  it('says where an edit change lands', () => {
    expect(noteHintLine(generateNoteHint('cut earlier', 4_000, PLAN), two)).toEqual({
      tone: 'muted',
      text: 'Edit change · both formats',
    });
    expect(noteHintLine(generateNoteHint('logo bigger', 32_000, PLAN), two).text).toBe(
      'Edit change · 1:1 only',
    );
    expect(noteHintLine(generateNoteHint('logo bigger', 32_000, PLAN)).text).toBe('Edit change');
  });

  it("ends the phone's line with what is left of the budget", () => {
    expect(
      noteHintLine(generateNoteHint('hand', 4_000, PLAN), {
        where: 'phone',
        state: { spendUsd: 2.33, budgetUsd: 3 },
      }).text,
    ).toBe('New take of clip B on Send · about $0.51 · $0.67 left of the $3');
  });

  it('adds up the footer against what is left of the budget', () => {
    const state = { spendUsd: 2.33, budgetUsd: 3 };
    expect(newTakesSentence(0.51, state)).toBe(
      'New takes use about $0.51 of the $0.67 left of the $3.',
    );
    expect(newTakesSentence(1.2, state)).toBe(
      'New takes need about $1.20, more than the $0.67 left of the $3: the worst one goes first.',
    );
    expect(newTakesSentence(0, state)).toBe('No new takes, so nothing spent on Higgsfield.');
    expect(newTakesSentence(0.67, state)).toBe(
      'New takes use about $0.67 of the $0.67 left of the $3.',
    );
  });
});

describe('generateNotePlanSchema', () => {
  it('parses the plan the route sends', () => {
    expect(generateNotePlanSchema.parse(PLAN)).toEqual(PLAN);
    expect(generateNotePlanSchema.safeParse({ clips: [] }).success).toBe(false);
  });
});
