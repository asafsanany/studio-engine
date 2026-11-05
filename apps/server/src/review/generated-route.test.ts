import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GenerateNotePlan,
  jobFormatsOf,
  type NoteRoute,
  type ReviewNote,
} from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeJob } from '../events/test-utils.js';
import type { NoteRouter } from './fix-router.js';
import {
  BOTH_FORMATS_WHY,
  clipNoteRoute,
  GuardedNoteRouter,
  generatedNoteRoute,
  raiseForFormats,
  VOICE_NOTE_ROUTE,
} from './generated-route.js';

// The rules the quick-fix router may not decide on its own (GN6, GN7): a clip or voice note of a
// generated video is full, and a quick note of a job with two formats waits for Send.

const PLAN: GenerateNotePlan = {
  clips: [
    { id: 'A', usd: 0.36, windows: [{ startSec: 0, endSec: 1 }] },
    { id: 'B', usd: 0.51, windows: [{ startSec: 1, endSec: 3 }] },
  ],
  lines: [
    { id: 'L1', startSec: 0, endSec: 1 },
    { id: 'L2', startSec: 1.4, endSec: 4 },
  ],
};

const QUICK: NoteRoute = { tier: 'quick', kind: 'Changing the caption font', why: '' };
const REVISE: NoteRoute = { tier: 'revise', kind: 'Replacing a shot', why: 'it changes the cut' };
const FULL: NoteRoute = { tier: 'full', kind: 'Pacing', why: 'it changes the whole video' };

describe('generatedNoteRoute with the plan Review has', () => {
  it('a clip word with a clip on screen is a new take of that clip: full', () => {
    expect(generatedNoteRoute('his hand looks wrong', 2, PLAN)).toEqual(clipNoteRoute('B'));
    expect(clipNoteRoute('B')).toEqual({
      tier: 'full',
      kind: 'New take of clip B',
      why: 'it needs a new take of a clip',
    });
    expect(generatedNoteRoute('the logo is warped', 0.5, PLAN)).toEqual(clipNoteRoute('A'));
  });

  it('the same words where no clip is on screen are an edit note (the end card is a graphic)', () => {
    expect(generatedNoteRoute('make the logo bigger', 3.5, PLAN)).toBeNull();
  });

  it('a voice word is the voice line made again: full, wherever it is', () => {
    expect(generatedNoteRoute('stress the BUT more', 0.2, PLAN)).toEqual(VOICE_NOTE_ROUTE);
    expect(generatedNoteRoute('the narrator is too quiet, louder', 3.5, PLAN)).toEqual(
      VOICE_NOTE_ROUTE,
    );
    expect(VOICE_NOTE_ROUTE).toEqual({
      tier: 'full',
      kind: 'Remaking a voice line',
      why: 'it needs the voice line made again',
    });
  });

  it('a clip word wins over a voice word when a clip is on screen, as in the hint', () => {
    expect(generatedNoteRoute('his hand moves when the voice says but', 2, PLAN)).toEqual(
      clipNoteRoute('B'),
    );
  });

  it('Hebrew notes are read by the same lists', () => {
    expect(generatedNoteRoute('היד שלו נראית מוזר', 2, PLAN)).toEqual(clipNoteRoute('B'));
    expect(generatedNoteRoute('ההדגשה חלשה', 0.2, PLAN)).toEqual(VOICE_NOTE_ROUTE);
  });

  it('an ordinary edit note is left to the router', () => {
    for (const text of [
      'make the captions yellow',
      'swap this shot',
      'shorter please',
      'change the title font to Heebo Bold',
    ]) {
      expect(generatedNoteRoute(text, 2, PLAN)).toBeNull();
    }
  });

  it('whole words only: handle and watermark are not a hand or water', () => {
    expect(generatedNoteRoute('the handle of the title is cut', 2, PLAN)).toBeNull();
    expect(generatedNoteRoute('remove the watermark', 2, PLAN)).toBeNull();
  });
});

describe('generatedNoteRoute without a plan', () => {
  it('holds back a note that mentions either kind, on the words alone', () => {
    expect(generatedNoteRoute('the hose bends', 2, null)).toEqual(clipNoteRoute(undefined));
    expect(clipNoteRoute(undefined).kind).toBe('New take of a clip');
    expect(generatedNoteRoute('say it slower', 2, null)).toEqual(VOICE_NOTE_ROUTE);
    expect(generatedNoteRoute('make the captions yellow', 2, null)).toBeNull();
  });
});

describe('raiseForFormats', () => {
  const two = { formats: jobFormatsOf(['1080x1920', '1080x1080']) };

  it('raises a quick route of a job with two formats to revise, keeping its kind', () => {
    expect(raiseForFormats(two, QUICK)).toEqual({
      tier: 'revise',
      kind: 'Changing the caption font',
      why: BOTH_FORMATS_WHY,
    });
    expect(BOTH_FORMATS_WHY).toBe('it has to change both formats');
  });

  it('leaves revise and full alone, and any route of a job with one format or none', () => {
    expect(raiseForFormats(two, REVISE)).toBe(REVISE);
    expect(raiseForFormats(two, FULL)).toBe(FULL);
    expect(raiseForFormats({}, QUICK)).toBe(QUICK);
    expect(raiseForFormats({ formats: undefined }, QUICK)).toBe(QUICK);
  });
});

describe('GuardedNoteRouter', () => {
  let inboxPath: string;

  beforeEach(() => {
    inboxPath = mkdtempSync(join(tmpdir(), 'studio-guarded-router-'));
  });

  afterEach(() => {
    rmSync(inboxPath, { recursive: true, force: true });
  });

  const job = makeJob({ relPath: 'Pinewood/Window Ad', state: 'review' });
  const editDir = () => join(inboxPath, job.relPath, 'edit');

  function put(path: string, content: unknown): void {
    const file = join(editDir(), path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(content));
  }

  /** A generated job on disk: its brief, and the hand-off Review reads its hints from. */
  function generated(): void {
    put('brief.json', { production: 'generate', budgetUsd: null });
    put('generate/shots.json', {
      shots: [
        {
          id: 'B',
          file: 'clips/B/take-1.mp4',
          take: 1,
          windows: [{ startSec: 1, endSec: 3 }],
          seconds: 2,
          shows: 'The technician fits the squeegee',
          model: 'alibaba/wan-3.0/image-to-video',
          usd: 0.51,
          belowBar: false,
        },
      ],
    });
    put('generate/voice-words.json', {
      words: [
        { line: 'L1', text: 'But', startSec: 0, endSec: 0.4 },
        { line: 'L2', text: 'Call', startSec: 1.4, endSec: 1.8 },
      ],
    });
  }

  function note(text: string | null, atSec = 2): ReviewNote {
    return {
      id: 'n1',
      jobId: job.id,
      round: null,
      atSec,
      kind: 'text',
      text,
      audioFile: null,
      audioSec: null,
      transcriptStatus: null,
      addToStyle: false,
      addToSeries: false,
      createdAt: '2026-10-25T14:00:00.000Z',
      sentAt: null,
      routeStatus: 'pending',
      route: null,
      format: null,
      fixId: null,
      fixedAt: null,
    };
  }

  function router(answer: NoteRoute = QUICK) {
    const inner = { route: vi.fn(async () => answer) } satisfies NoteRouter;
    return { inner, guarded: new GuardedNoteRouter(inner, { inboxPath }) };
  }

  it('answers a clip note of a generated job itself: the inner router is never asked', async () => {
    generated();
    const { inner, guarded } = router();
    expect(await guarded.route(job, note('the hand is bent'))).toEqual(clipNoteRoute('B'));
    expect(inner.route).not.toHaveBeenCalled();
  });

  it('answers a voice note of a generated job itself', async () => {
    generated();
    const { inner, guarded } = router();
    expect(await guarded.route(job, note('stress BUT more', 0.2))).toEqual(VOICE_NOTE_ROUTE);
    expect(inner.route).not.toHaveBeenCalled();
  });

  it('with a brief but no valid hand-off yet, the words alone hold the note back', async () => {
    put('brief.json', { production: 'generate' });
    const { inner, guarded } = router();
    expect(await guarded.route(job, note('the hand is bent'))).toEqual(clipNoteRoute(undefined));
    expect(inner.route).not.toHaveBeenCalled();
  });

  it('asks the inner router for any other note of a generated job, and passes its answer on', async () => {
    generated();
    const { inner, guarded } = router(QUICK);
    const given = note('make the captions yellow');
    expect(await guarded.route(job, given)).toBe(QUICK);
    expect(inner.route).toHaveBeenCalledOnce();
    expect(inner.route).toHaveBeenCalledWith(job, given, undefined);
  });

  it('passes the abort signal on', async () => {
    const { inner, guarded } = router(REVISE);
    const controller = new AbortController();
    await guarded.route(job, note('swap this shot'), controller.signal);
    expect(inner.route).toHaveBeenCalledWith(job, expect.anything(), controller.signal);
  });

  it('does not touch a footage job: a clip word goes to the inner router like any note', async () => {
    const { inner, guarded } = router(QUICK);
    expect(await guarded.route(job, note('the hand is bent'))).toBe(QUICK);
    expect(inner.route).toHaveBeenCalledOnce();

    put('brief.json', { production: 'footage' });
    expect(await guarded.route(job, note('stress BUT more'))).toBe(QUICK);
    expect(inner.route).toHaveBeenCalledTimes(2);
  });

  it('raises a quick answer for a job with two formats, and only a quick one', async () => {
    const two = makeJob({
      relPath: job.relPath,
      state: 'review',
      formats: jobFormatsOf(['1080x1920', '1080x1080']),
    });
    const quick = router(QUICK);
    expect(await quick.guarded.route(two, note('make the captions yellow'))).toEqual({
      tier: 'revise',
      kind: 'Changing the caption font',
      why: BOTH_FORMATS_WHY,
    });
    const revise = router(REVISE);
    expect(await revise.guarded.route(two, note('swap this shot'))).toBe(REVISE);
  });

  it('a generated job with two formats: the clip note is full, not raised', async () => {
    generated();
    const two = makeJob({
      relPath: job.relPath,
      state: 'review',
      formats: jobFormatsOf(['1080x1920', '1080x1080']),
    });
    const { guarded } = router();
    expect(await guarded.route(two, note('the hand is bent'))).toEqual(clipNoteRoute('B'));
  });

  it('a note with no words is the inner router’s to read', async () => {
    generated();
    const { inner, guarded } = router(FULL);
    expect(await guarded.route(job, note(null))).toBe(FULL);
    expect(inner.route).toHaveBeenCalledOnce();
  });

  it('does not call the inner router when it is aborted while it reads the job’s files', async () => {
    generated();
    const { inner, guarded } = router();
    const controller = new AbortController();
    // Not awaited: the abort comes in while the guard is still reading the brief.
    const answer = guarded.route(job, note('make the captions yellow'), controller.signal);
    controller.abort(new Error('stop'));
    await expect(answer).rejects.toThrow('stop');
    expect(inner.route).not.toHaveBeenCalled();
  });

  it('stops at once when it is already aborted', async () => {
    const { inner, guarded } = router();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(guarded.route(job, note('x'), controller.signal)).rejects.toThrow('stop');
    expect(inner.route).not.toHaveBeenCalled();
  });
});
