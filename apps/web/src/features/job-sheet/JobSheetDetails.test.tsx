import type { Job, MusicView } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeMusicPlan, makeMusicVersion, makeMusicView } from '@/data/test-utils';
import { JobSheetDetails } from './JobSheetDetails';
import { JOB_SHEET_STATES, type JobSheetState, jobSheetJobs, jobSheetNow } from './test-fixtures';

const render = (job: Job, now: string) =>
  renderToStaticMarkup(<JobSheetDetails job={job} now={now} timeZone="UTC" />);

/** The `[label, value]` pairs of the rendered part, in order. */
function pairs(html: string): [string, string][] {
  return [...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(
    ([, label = '', value = '']) => [label, value],
  );
}

const renderState = (state: JobSheetState) => render(jobSheetJobs[state], jobSheetNow[state]);

describe('JobSheetDetails', () => {
  it('has a muted 13 px "Details" heading', () => {
    const html = renderState('review');
    expect(html).toContain('aria-label="Details"');
    expect(html).toMatch(
      /<h3 class="[^"]*text-\[13px\][^"]*text-muted-foreground[^"]*">Details<\/h3>/,
    );
  });

  it('shows the rows of the review board', () => {
    expect(pairs(renderState('review'))).toEqual([
      ['Inputs', '8 video clips · 1 audio file · 3 images'],
      ['Added', 'Today, 13:01'],
      ['Folder', 'Studio Inbox/LAKESHORE/סיור בפרויקט'],
    ]);
  });

  it('shows the rows of the delivered board, with no folder once there is an MP4', () => {
    expect(pairs(renderState('delivered')).map(([label]) => label)).toEqual([
      'Money',
      'Video',
      'File',
      'Inputs',
      'Added',
    ]);
    expect(pairs(renderState('delivered'))[0]).toEqual([
      'Money',
      '₪40 · delivered 21 Oct · not paid',
    ]);
  });

  it('puts the label in a 96 px column and lets the value wrap anywhere in its own direction', () => {
    const html = renderState('approved');
    expect(html).toContain('grid-cols-[96px_minmax(0,1fr)]');
    expect(html).toMatch(/<dd dir="auto" class="[^"]*wrap-anywhere/);
    expect(html).toMatch(/<dd dir="auto" class="[^"]*\[unicode-bidi:plaintext\]/);
  });

  it('mutes the paths, not the other values', () => {
    const html = renderState('approved');
    const value = (label: string) =>
      html.match(new RegExp(`data-detail="${label}"[^>]*>.*?<dd dir="auto" class="([^"]*)"`))?.[1];
    expect(value('File')).toContain('text-muted-foreground');
    expect(value('Video')).not.toContain('text-muted-foreground');
    expect(value('Inputs')).not.toContain('text-muted-foreground');
  });

  it('reads the clock without a pinned time', () => {
    const html = renderToStaticMarkup(<JobSheetDetails job={jobSheetJobs.approved} />);
    expect(pairs(html).map(([label]) => label)).toEqual(['Video', 'File', 'Inputs', 'Added']);
  });

  it('has something to say for every state of the boards', () => {
    for (const state of JOB_SHEET_STATES) {
      expect(renderState(state), state).not.toBe('');
    }
  });
});

// The Music row (Soundtrack, boards SDSheet and SDPhone): a value, and a second muted line under it.
describe('JobSheetDetails: the Music row', () => {
  const failed: MusicView = makeMusicView({
    picked: null,
    versions: [],
    picks: [],
    failure: {
      id: 'v1',
      code: 'no_credits',
      message: 'ElevenLabs says this month’s credits are used up.',
      at: '2026-10-22T13:06:00.000Z',
    },
  });
  const twoVersions: MusicView = makeMusicView({
    picked: 'v2',
    versions: [
      makeMusicVersion(1),
      makeMusicVersion(2, { by: 'you', ask: 'darker drums', describe: 'You asked: darker drums.' }),
    ],
  });

  const withMusic = (job: Job, now: string, music: MusicView | null, variant?: 'phone') =>
    renderToStaticMarkup(
      <JobSheetDetails job={job} now={now} timeZone="UTC" music={music} variant={variant} />,
    );
  const review = (music: MusicView | null) =>
    withMusic(jobSheetJobs.review, jobSheetNow.review, music);

  /** The tag of the dd under the Music row's label, and the sub line's tag. */
  const valueTag = (html: string) =>
    html.match(/data-detail="Music"[^>]*>.*?(<dd dir="auto" class="[^"]*">)/)?.[1] ?? '';
  const subTag = (html: string) => html.match(/<dd[^>]*data-detail-sub="Music"[^>]*>/)?.[0] ?? '';

  it('comes after Inputs and before Added', () => {
    expect(pairs(review(makeMusicView())).map(([label]) => label)).toEqual([
      'Inputs',
      'Music',
      'Added',
      'Folder',
    ]);
  });

  it('shows its value, then its second line under it', () => {
    const html = review(twoVersions);
    expect(pairs(html)[1]).toEqual(['Music', 'Made for this video · v2 of 2']);
    expect(html).toMatch(
      /data-detail="Music"[^>]*><dt[^>]*>Music<\/dt><dd[^>]*>Made for this video · v2 of 2<\/dd><dd[^>]*>You asked: darker drums\.<\/dd><\/div>/,
    );
  });

  it('draws the second line muted and a little smaller, in the value’s column, in its own direction', () => {
    const tag = subTag(review(twoVersions));
    expect(tag).toContain('col-start-2');
    expect(tag).toContain('text-[13px]');
    expect(tag).toContain('text-muted-foreground');
    expect(tag).toContain('dir="auto"');
    expect(tag).toContain('[unicode-bidi:plaintext]');
    expect(tag).toContain('wrap-anywhere');
  });

  it('draws the value in the normal colour', () => {
    const tag = valueTag(review(twoVersions));
    expect(tag).not.toContain('text-muted-foreground');
    expect(tag).not.toContain('text-status-failed-foreground');
  });

  it('draws music that could not be made in the failure colour, with the reason muted under it', () => {
    const html = review(failed);
    expect(pairs(html)[1]).toEqual(['Music', 'None · couldn’t make it']);
    expect(valueTag(html)).toContain('text-status-failed-foreground');
    expect(subTag(html)).toContain('text-muted-foreground');
    expect(subTag(html)).not.toContain('text-status-failed-foreground');
    expect(html).toContain('ElevenLabs says this month’s credits are used up.');
  });

  it('has no second line, and no empty one, for a row without one', () => {
    const html = review(makeMusicView({ picked: 'off' }));
    expect(pairs(html)[1]).toEqual(['Music', 'None · you turned it off']);
    expect(html).not.toContain('data-detail-sub');
  });

  it('keeps the other rows as they were, with no second line anywhere', () => {
    const html = review(null);
    expect(html).not.toContain('data-detail-sub');
    expect(html).not.toContain('Music');
    expect(html).toBe(renderState('review'));
  });

  it('has no Music row for a record with nothing to say', () => {
    const empty = makeMusicView({ picked: null, versions: [], picks: [] });
    expect(pairs(review(empty)).map(([label]) => label)).toEqual(['Inputs', 'Added', 'Folder']);
  });

  it('keeps a Hebrew file name in its own direction', () => {
    const html = review(
      makeMusicView({ source: 'supplied', file: 'מוזיקה/שיר קיץ.mp3', picked: 'file' }),
    );
    expect(pairs(html)[1]).toEqual(['Music', 'שיר קיץ.mp3']);
    expect(valueTag(html)).toContain('dir="auto"');
  });

  it('shows "Making it now" and what is being written while the first version is made', () => {
    const html = review(
      makeMusicView({
        picked: null,
        versions: [],
        picks: [],
        making: { id: 'v1', ask: null, startedAt: '2026-10-22T13:05:00.000Z' },
      }),
    );
    expect(pairs(html)[1]).toEqual(['Music', 'Making it now']);
    expect(html).toContain('Written to the cut by ElevenLabs. No music file was in the folder.');
  });

  describe('on the phone (boards MJobSheet*, SDPhone)', () => {
    it('is in the Ready to review job’s rows between Inputs and Added, 112 px label column', () => {
      const html = withMusic(jobSheetJobs.review, jobSheetNow.review, twoVersions, 'phone');
      expect(pairs(html).map(([label]) => label)).toEqual(['Inputs', 'Music', 'Added', 'Folder']);
      expect(html).toContain('grid-cols-[112px_minmax(0,1fr)]');
      expect(html).toContain('data-detail-sub="Music"');
    });

    it('is in an Approved job’s rows between Inputs and Approved', () => {
      const html = withMusic(jobSheetJobs.approved, jobSheetNow.approved, twoVersions, 'phone');
      expect(pairs(html).map(([label]) => label)).toEqual(['Inputs', 'Music', 'Approved', 'File']);
    });

    it('is left out of a Delivered job’s and a Paid job’s rows: the boards’ short money lists', () => {
      for (const state of ['delivered', 'paid'] as const) {
        const html = withMusic(jobSheetJobs[state], jobSheetNow[state], twoVersions, 'phone');
        expect(html, state).not.toContain('Music');
      }
    });
  });

  it('shows the version’s own line under a made version', () => {
    const html = review(makeMusicView());
    expect(html).toContain(makeMusicPlan().describe);
  });
});
