import { describe, expect, it } from 'vitest';
import { DRAFT_STAGES, draftStageOf, jobFeedResponseSchema } from './job-feed.ts';
import { STEP_IDS } from './steps.ts';

describe('draftStageOf', () => {
  it('puts every step up to Check in one of the Draft’s six stages, and Render in none', () => {
    expect(STEP_IDS.map((step) => draftStageOf(step))).toEqual([
      'instructions',
      'footage',
      'footage',
      'plan',
      'cut',
      'preview',
      'check',
      null,
    ]);
    expect(draftStageOf(null)).toBeNull();
  });

  it('lists the stages in the order the Draft goes through them', () => {
    expect(DRAFT_STAGES.map((stage) => stage.label)).toEqual([
      'Instructions',
      'Footage',
      'Plan',
      'Cut',
      'Preview',
      'Check',
    ]);
  });
});

describe('jobFeedResponseSchema', () => {
  it('reads a feed with each kind of item', () => {
    const feed = {
      jobId: 'abc123',
      rev: 42,
      items: [
        {
          id: 'L1',
          at: '2026-10-25T20:58:11.384Z',
          kind: 'run',
          run: 'draft',
          round: null,
          mode: 'start',
          endedAt: null,
          outcome: null,
          error: null,
          durationMs: null,
          notes: [],
        },
        { id: 'L2-0', at: null, kind: 'text', text: 'Reading the brief first.' },
        {
          id: 'L3-0',
          at: null,
          kind: 'tools',
          tools: [
            { id: 't1', tool: 'Bash', label: 'Transcribe', detail: 'python x', state: 'done' },
          ],
        },
        {
          id: 'L4-0',
          at: null,
          kind: 'images',
          images: [{ name: 'L4-0.jpg', label: 'Cut sheet', path: 'edit/x.jpg', wide: true }],
        },
        {
          id: 'L5-0',
          at: null,
          kind: 'card',
          card: { type: 'loudness', integratedLufs: -14, truePeakDb: -1.5, rangeLu: null },
        },
      ],
    };
    expect(jobFeedResponseSchema.parse(feed)).toEqual(feed);
  });

  it('refuses a picture name that could leave the feed’s folder', () => {
    const bad = {
      jobId: 'abc123',
      rev: 1,
      items: [
        {
          id: 'L4-0',
          at: null,
          kind: 'images',
          images: [{ name: '../x.jpg', label: 'x', path: null, wide: false }],
        },
      ],
    };
    expect(jobFeedResponseSchema.safeParse(bad).success).toBe(false);
  });
});
