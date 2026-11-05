import { type Job, noteRouteSchema, type ReviewNote } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyNote, FAKE_ROUTE_DELAY_MS, FakeNoteRouter } from './fake-fix-router.js';
import { UNREADABLE_ROUTE } from './fix-router.js';

// The fake router's keyword rules: the design board's classify(), in English and Hebrew.

const JOB = { id: 'job-1', client: 'Acme', name: 'Demo' } as Job;
const noteOf = (text: string | null): ReviewNote =>
  ({ id: 'n1', jobId: 'job-1', atSec: 12, kind: 'text', text }) as ReviewNote;

afterEach(() => {
  vi.useRealTimers();
});

describe('the keyword rules', () => {
  // The owner's ten notes of the real check. The fake follows the board, so it calls the sign quick
  // (the board's fake fix then says it can't); the real router calls it revise.
  it.each([
    ['Change the caption font to Heebo Bold', 'quick', 'Changing the caption font', ''],
    ['the subtitle at 0:12 should say ככה זה התחיל', 'quick', "Changing the caption's words", ''],
    ['תוריד את הכותרת', 'quick', 'Changing the title', ''],
    ['move the captions higher, they cover her chin', 'quick', 'Moving the captions', ''],
    [
      'swap this shot for the drone shot from the beach',
      'revise',
      'Changing the cut',
      'it changes the cut',
    ],
    ['the music should come in at 0:05', 'revise', 'Changing the music', 'it changes the music'],
    [
      'the middle drags, cut on the beat',
      'full',
      'Changing the pacing',
      'it changes the whole video',
    ],
    ['change the sign behind her to English', 'quick', 'Changing the sign', ''],
    ['make the logo at the end bigger', 'quick', 'Changing the logo', ''],
    ['תעשה את הכתוביות צהובות', 'quick', 'Changing the caption colour', ''],
  ])('%s -> %s', (text, tier, kind, why) => {
    expect(classifyNote(text)).toEqual({ tier, kind, why });
  });

  it('puts the whole-video words before the others, as the board does', () => {
    expect(classifyNote('Tighten the pacing of the captions').tier).toBe('full');
    expect(classifyNote('Make the music shorter').tier).toBe('full');
    expect(classifyNote('קצב איטי מדי').tier).toBe('full');
  });

  it('calls the music, the look and the cut revise, each with its own reason', () => {
    expect(classifyNote('Replace the song').why).toBe('it changes the music');
    expect(classifyNote('התחלה עם מוזיקה אחרת').why).toBe('it changes the music');
    expect(classifyNote('It is too bright here').why).toBe('it changes the look of the footage');
    expect(classifyNote('Use @luts/golden-hour-warm').why).toBe(
      'it changes the look of the footage',
    );
    expect(classifyNote('Trim the opening').why).toBe('it changes the cut');
    expect(classifyNote('החלף את השוט').why).toBe('it changes the cut');
  });

  it('calls text, font, colour, size, position and logo notes quick, in any case', () => {
    for (const text of [
      'FONT',
      'Make the TITLE bigger',
      'צבע אחר לטקסט',
      'Put the logo lower',
      'fix the typo',
      'thinner weight',
    ]) {
      expect(classifyNote(text)).toMatchObject({ tier: 'quick', why: '' });
    }
  });

  it('calls anything else revise, because it may change the cut', () => {
    expect(classifyNote('Make it nicer')).toEqual({
      tier: 'revise',
      kind: 'Changing the edit',
      why: 'it may change the cut',
    });
  });

  it('only gives routes the contract accepts', () => {
    for (const text of ['font', 'swap the shot', 'the music', 'pacing', 'whatever', 'צבע']) {
      expect(noteRouteSchema.safeParse(classifyNote(text)).success).toBe(true);
    }
  });
});

describe('the fake router', () => {
  it('answers after 300 ms', async () => {
    vi.useFakeTimers();
    const router = new FakeNoteRouter();
    const answer = vi.fn();
    void router.route(JOB, noteOf('make the captions yellow')).then(answer);

    await vi.advanceTimersByTimeAsync(FAKE_ROUTE_DELAY_MS - 1);
    expect(answer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toHaveBeenCalledWith({
      tier: 'quick',
      kind: 'Changing the caption colour',
      why: '',
    });
    expect(FAKE_ROUTE_DELAY_MS).toBe(300);
  });

  it('can be told another delay', async () => {
    vi.useFakeTimers();
    const answer = vi.fn();
    void new FakeNoteRouter({ delayMs: 5 }).route(JOB, noteOf('font')).then(answer);
    await vi.advanceTimersByTimeAsync(5);
    expect(answer).toHaveBeenCalledOnce();
  });

  it('answers full for a note with no text', async () => {
    vi.useFakeTimers();
    const answer = vi.fn();
    void new FakeNoteRouter().route(JOB, noteOf(null)).then(answer);
    await vi.advanceTimersByTimeAsync(300);
    expect(answer).toHaveBeenCalledWith(UNREADABLE_ROUTE);
  });

  it('rejects when it is aborted, at once, and answers nothing later', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const router = new FakeNoteRouter();
    const answer = vi.fn();
    const failed = vi.fn();
    void router.route(JOB, noteOf('font'), controller.signal).then(answer, failed);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(answer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects without waiting when it is aborted already', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new FakeNoteRouter().route(JOB, noteOf('font'), controller.signal),
    ).rejects.toBeDefined();
  });
});
