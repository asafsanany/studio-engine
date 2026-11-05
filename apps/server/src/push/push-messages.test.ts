import { type GenerateState, generateErrorMessage, initialGenerateState } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob } from '../events/test-utils.js';
import { describeFailure } from '../pipeline/failure.js';
import { emptySummary } from '../pipeline/stream-parser.js';
import { badgeCount, isUsageLimitFailure, pingFor, QUEUE_EMPTY_TAG } from './push-messages.js';

const DELIVERY = {
  deliveredAt: '2026-10-22T10:00:00.000Z',
  price: 40,
  currency: 'ILS',
  paidOn: null,
};

/** A generated job that made 4 of its 6 clips, $1.65 of the $3. */
const CLIPS_STATE: GenerateState = {
  ...initialGenerateState(3),
  phase: 'clips',
  counts: {
    voice: { done: 7, total: 7 },
    looks: { done: 3, total: 3 },
    keyframes: { done: 7, total: 7 },
    clips: { done: 4, total: 6 },
    belowBar: 0,
  },
  spendUsd: 1.65,
};

// Hebrew names go through untouched: the body is "<job> · <client>".
const hebrew = { id: 'f00dfeed0001', name: 'סיור בפרויקט', client: 'LAKESHORE' };

describe('pingFor', () => {
  it('Ready to review opens the review address', () => {
    expect(pingFor('review', makeJob({ ...hebrew, state: 'review' }))).toEqual({
      title: 'Ready to review',
      body: 'סיור בפרויקט · LAKESHORE',
      url: '/jobs?job=f00dfeed0001&review=1',
      tag: 'f00dfeed0001',
    });
  });

  it('Failed at <Step> opens the sheet', () => {
    const job = makeJob({ ...hebrew, state: 'failed', failedAt: 8, error: 'Disk is full.' });
    expect(pingFor('failed', job)).toEqual({
      title: 'Failed at Render',
      body: 'סיור בפרויקט · LAKESHORE',
      url: '/jobs?job=f00dfeed0001',
      tag: 'f00dfeed0001',
    });
  });

  it('Failed says only Failed when no step is known', () => {
    expect(pingFor('failed', makeJob({ state: 'failed', failedAt: null })).title).toBe('Failed');
  });

  it('a usage limit says so in the title and adds "retry once it resets" to the body', () => {
    const job = makeJob({
      ...hebrew,
      state: 'failed',
      failedAt: 5,
      error: 'Claude usage limit reached. Retry once it resets. (resets 7pm)',
    });
    expect(pingFor('failed', job)).toEqual({
      title: 'Failed · Claude usage limit',
      body: 'סיור בפרויקט · LAKESHORE · retry once it resets',
      url: '/jobs?job=f00dfeed0001',
      tag: 'f00dfeed0001',
    });
  });

  it('Approved · ready to send opens the sheet', () => {
    expect(pingFor('approved', makeJob({ ...hebrew, state: 'ready', runKind: 'render' }))).toEqual({
      title: 'Approved · ready to send',
      body: 'סיור בפרויקט · LAKESHORE',
      url: '/jobs?job=f00dfeed0001',
      tag: 'f00dfeed0001',
    });
  });

  it('Queue is empty is about no job and opens Jobs', () => {
    expect(pingFor('queueEmpty', null)).toEqual({
      title: 'Queue is empty',
      body: 'Everything you dropped in is done.',
      url: '/jobs',
      tag: QUEUE_EMPTY_TAG,
    });
  });

  it('a job that stopped in Generate says what to do, and opens the sheet (board GNPhone)', () => {
    const job = makeJob({
      id: 'f00dfeed0002',
      name: '97 Window Ad',
      client: 'Pinewood',
      state: 'failed',
      step: 1,
      failedAt: 1,
      error: generateErrorMessage('balance_empty'),
      generate: CLIPS_STATE,
    });
    expect(pingFor('failed', job)).toEqual({
      title: '97 Window Ad stopped',
      body: 'The Higgsfield balance is empty. Add funds in the Higgsfield console, then press Retry. The 4 clips made are kept.',
      url: '/jobs?job=f00dfeed0002',
      tag: 'f00dfeed0002',
    });
  });

  it('says the key was not accepted and what an over-budget video needs', () => {
    const base = { name: '97 Window Ad', state: 'failed', failedAt: 1 } as const;
    const key = makeJob({ ...base, error: generateErrorMessage('key_rejected') });
    expect(pingFor('failed', key).body).toBe(
      'Higgsfield did not accept the key. Check HIGGSFIELD_API_KEY in .env, then press Retry.',
    );
    const over = makeJob({
      ...base,
      error: generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }),
    });
    expect(pingFor('failed', over).body).toBe(
      'This video needs about $4.10, over the budget of $3. Add a note like “budget $5”, then press Retry.',
    );
  });

  it('a Generate ping carries neither the client nor the error text', () => {
    const job = makeJob({
      name: '97 Window Ad',
      client: 'Pinewood',
      state: 'failed',
      failedAt: 1,
      error: generateErrorMessage('unavailable'),
    });
    const text = JSON.stringify(pingFor('failed', job));
    expect(text).not.toContain('Pinewood');
    expect(text).not.toContain('not answering right now');
  });

  it('a failure of Brief in an ordinary job keeps its Failed at Brief ping', () => {
    const job = makeJob({ ...hebrew, state: 'failed', failedAt: 1, error: 'Disk is full.' });
    expect(pingFor('failed', job).title).toBe('Failed at Brief');
  });

  it('never carries the error text or anything else about the job', () => {
    const job = makeJob({ state: 'failed', failedAt: 3, error: 'secret path /Users/owner/x' });
    expect(JSON.stringify(pingFor('failed', job))).not.toContain('secret');
  });
});

describe('isUsageLimitFailure', () => {
  const failureOf = (stderr: string): string =>
    describeFailure({ exitCode: 1, signal: null, stderr, stream: emptySummary() });

  it('knows the message failure.ts writes for a usage limit, and no other', () => {
    const usage = failureOf('You have hit your limit. Resets 7pm.');
    expect(usage).toMatch(/usage limit/i);
    expect(isUsageLimitFailure({ error: usage })).toBe(true);

    expect(isUsageLimitFailure({ error: failureOf('no space left on device') })).toBe(false);
    expect(isUsageLimitFailure({ error: failureOf('overloaded') })).toBe(false);
    expect(isUsageLimitFailure({ error: null })).toBe(false);
  });
});

describe('badgeCount', () => {
  it('counts the jobs in Review and the ones that need attention', () => {
    const jobs = [
      makeJob({ state: 'review' }),
      makeJob({ state: 'failed' }),
      makeJob({ state: 'held' }),
      makeJob({ state: 'cancelled' }),
      makeJob({ state: 'editing' }),
      makeJob({ state: 'queued' }),
      makeJob({ state: 'arriving' }),
      makeJob({ state: 'ready' }),
      makeJob({ state: 'ready', delivery: DELIVERY }),
    ];
    expect(badgeCount(jobs)).toBe(4);
  });

  it('leaves archived jobs out, like the header', () => {
    const archivedAt = '2026-10-22T10:00:00.000Z';
    expect(
      badgeCount([
        makeJob({ state: 'failed', archivedAt }),
        makeJob({ state: 'review', archivedAt }),
        makeJob({ state: 'review' }),
      ]),
    ).toBe(1);
  });

  it('is 0 for nothing', () => {
    expect(badgeCount([])).toBe(0);
  });
});
