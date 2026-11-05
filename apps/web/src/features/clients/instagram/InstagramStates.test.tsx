import type { ClientInstagram, InstagramScan } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createTestQueryClient } from '@/data/test-utils';
import { InstagramSection } from './InstagramSection';
import { FALCON_NOW, FALCON_TIME_ZONE, falconInstagram } from './test-instagram';
import type { InstagramSectionState } from './use-instagram-section';

// The states of the Instagram section that are not the numbers (boards CLStates S2, S3, S8, S9),
// drawn by the section as the client page does.

const OPTIONS = { timeZone: FALCON_TIME_ZONE, now: FALCON_NOW };

function render(data: ClientInstagram): string {
  const state: InstagramSectionState = {
    on: true,
    data,
    loading: false,
    range: 'since',
    setRange: () => undefined,
    stale: false,
  };
  return renderToStaticMarkup(
    <QueryClientProvider client={createTestQueryClient()}>
      <InstagramSection clientId="falcon-fpv" state={state} textOptions={OPTIONS} />
    </QueryClientProvider>,
  );
}

const lastScan = (scan: Partial<InstagramScan>): InstagramScan => ({
  startedAt: '2026-10-26T04:00:00.000Z',
  finishedAt: '2026-10-26T04:01:00.000Z',
  outcome: 'failed',
  error: null,
  followers: null,
  following: null,
  posts: null,
  reelsRead: 0,
  costUsd: 0,
  ...scan,
});

/** An account with no numbers: no scan has been able to read it. */
const withoutNumbers = (scan: Partial<InstagramScan>): ClientInstagram => ({
  ...falconInstagram(),
  numbers: null,
  reels: [],
  lastScan: lastScan(scan),
});

/** The section's labelled cards (the tiles and the charts), in order. */
const cards = (markup: string) =>
  [...markup.matchAll(/<section aria-label="([^"]+)"/g)].map((m) => m[1]);

/** The `scan-problem` block of the markup, or ''. */
const problemOf = (markup: string) =>
  markup.match(/<div data-slot="scan-problem".*?(?=<section aria-label="Followers"|$)/s)?.[0] ?? '';

describe('No Instagram yet (S8)', () => {
  const markup = render({
    ...falconInstagram(),
    account: null,
    numbers: null,
    reels: [],
    lastScan: null,
  });

  it('says what an account is for and what it costs, in a dashed box', () => {
    expect(markup).toContain('border-dashed');
    expect(markup).toContain('Add their Instagram to see how our videos do there.');
    expect(markup).toContain('It’s read once a week, about $0.05.');
    expect(markup).toContain('lucide-at-sign');
  });

  it('has an Add Instagram button with a plus, which asks for the dialog', () => {
    expect(markup).toMatch(
      /<button[^>]*data-variant="outline"[^>]*>.*lucide-plus.*Add Instagram<\/button>/s,
    );
  });

  it('has none of the section’s other parts', () => {
    expect(markup).not.toContain('Scan now');
    expect(markup).not.toContain('Followers');
    expect(markup).not.toContain('id="client-instagram"');
  });
});

describe('The first scan (S2)', () => {
  const reading = render({
    ...falconInstagram(),
    numbers: null,
    reels: [],
    lastScan: null,
    scanning: true,
  });

  it('says whose page it is reading and that it takes about a minute', () => {
    expect(reading).toMatch(/<p role="status"[^>]*>.*Reading @falcon\.fpv… about a minute<\/p>/s);
    expect(reading).toContain('aria-busy="true"');
  });

  it('keeps the head, with Scanning… and no range to choose yet', () => {
    expect(reading).toMatch(/<h2 id="client-instagram"[^>]*>Instagram<\/h2>/);
    expect(reading).toContain('Scanning now');
    expect(reading).toContain('Scanning…');
    expect(reading).not.toContain('aria-label="Range"');
  });

  it('draws no grey places until the wait is noticeable (the skeletons are delayed)', () => {
    expect(reading).not.toContain('animate-pulse');
    expect(cards(reading)).toEqual([]);
  });

  it('is the same for an account that is saved and not scanned yet', () => {
    const queued = render({ ...falconInstagram(), numbers: null, reels: [], lastScan: null });
    expect(queued).toContain('Reading @falcon.fpv… about a minute');
  });

  it('is not shown once there are numbers: a scan then is the head’s Scanning now', () => {
    const rescanning = render({ ...falconInstagram(), scanning: true });
    expect(rescanning).not.toContain('Reading @');
    expect(cards(rescanning)).toContain('Followers');
  });
});

describe('When a scan can’t run (S3), with no numbers yet', () => {
  it('private: a lock, the words, and Edit account', () => {
    const line = problemOf(render(withoutNumbers({ outcome: 'private' })));
    expect(line).toContain('data-outcome="private"');
    expect(line).toContain('lucide-lock');
    expect(line).toContain('The account is private');
    expect(line).toContain('Ask them to make it public, or switch to a business account.');
    expect(line).toMatch(/<button[^>]*>Edit account<\/button>/);
  });

  it('not found: a magnifier, the handle, and Edit account', () => {
    const data = withoutNumbers({ outcome: 'not-found' });
    if (data.account === null) throw new Error('the fixture has an account');
    data.account.handle = 'falcon_fpv';
    const line = problemOf(render(data));
    expect(line).toContain('lucide-search');
    expect(line).toContain('No account called @falcon_fpv');
    expect(line).toContain('Check the name, or paste the link from their profile.');
    expect(line).toMatch(/<button[^>]*>Edit account<\/button>/);
  });

  it('no token: an amber mark, APIFY_TOKEN in .env, and How to', () => {
    const line = problemOf(render(withoutNumbers({ outcome: 'no-token' })));
    expect(line).toContain('lucide-circle-alert');
    expect(line).toContain('text-amber-400');
    expect(line).toContain('Apify isn’t set up');
    expect(line).toContain('APIFY_TOKEN is missing from .env.');
    expect(line).toMatch(/<button[^>]*>How to<\/button>/);
  });

  it('no credit: when the scans go on, and Open Apify as a link that opens a new tab', () => {
    const line = problemOf(render(withoutNumbers({ outcome: 'no-credit' })));
    expect(line).toContain('Apify’s credit is used up');
    expect(line).toContain('Scans pause until 1 Nov, or add credit on apify.com.');
    expect(line).toMatch(
      /<a href="https:\/\/console\.apify\.com\/billing" target="_blank" rel="noreferrer"[^>]*>Open Apify<\/a>/,
    );
  });

  it('failed: a red mark, the day, and Retry', () => {
    const line = problemOf(
      render(withoutNumbers({ outcome: 'failed', error: 'Apify run FAILED' })),
    );
    expect(line).toContain('text-red-400');
    expect(line).toContain('The scan of Mon 26 Oct failed');
    expect(line).toContain('Instagram didn’t answer.');
    expect(line).toContain('title="Apify run FAILED"');
    expect(line).toMatch(/<button[^>]*>Retry<\/button>/);
  });

  it('is a line and nothing else: no tiles, no charts', () => {
    const markup = render(withoutNumbers({ outcome: 'private' }));
    expect(cards(markup)).toEqual([]);
    expect(markup).not.toContain('Reading @');
    expect(markup).toContain('Scan now');
  });

  it('is gone while a scan runs (that is S2 again)', () => {
    const markup = render({ ...withoutNumbers({ outcome: 'failed' }), scanning: true });
    expect(markup).not.toContain('data-slot="scan-problem"');
    expect(markup).toContain('Reading @falcon.fpv');
  });
});

describe('When a scan can’t run (S3), with older numbers', () => {
  const markup = render({ ...falconInstagram(), lastScan: lastScan({ outcome: 'failed' }) });

  it('puts the line between the head and the tiles, and says what day the numbers are from', () => {
    const head = markup.indexOf('id="client-instagram"');
    const line = markup.indexOf('data-slot="scan-problem"');
    const tiles = markup.indexOf('<section aria-label="Followers"');
    expect(head).toBeLessThan(line);
    expect(line).toBeLessThan(tiles);
    expect(markup).toContain('Instagram didn’t answer. The numbers are from Mon 26 Oct.');
  });

  it('keeps the numbers: the tiles and the charts are all there, and the range', () => {
    expect(cards(markup)).toEqual([
      'Followers',
      'Plays per reel',
      'Likes per reel',
      'Shares a week',
      'Plays of every reel',
      'Views, likes, comments and shares',
      'Reels',
    ]);
    expect(markup).toContain('aria-label="Range"');
  });
});

describe('Delivered, none linked (S9)', () => {
  const data = falconInstagram();
  const none: ClientInstagram = {
    ...data,
    reels: data.reels.map((reel) => ({ ...reel, job: null })),
    linkableJobs: [
      {
        jobId: 'a',
        name: '97 Window Ad',
        deliveredAt: '2026-10-11T10:00:00.000Z',
        stage: 'delivered',
      },
      {
        jobId: 'b',
        name: 'Window cleaning ad',
        deliveredAt: '2026-10-12T10:00:00.000Z',
        stage: 'paid',
      },
    ],
  };
  const markup = render(none);

  it('says none is linked, how many we delivered and which, and what to do', () => {
    expect(markup).toContain('data-slot="none-linked"');
    expect(markup).toContain('None of our videos is linked to a reel yet.');
    expect(markup).toContain('We delivered 2 (');
    expect(markup).toContain(
      '<span><bdi>Window cleaning ad</bdi></span><span>, <bdi>97 Window Ad</bdi></span>',
    );
    expect(markup).toContain(
      'When they are up, right-click the reel below › Link to job. Their own reels show meanwhile.',
    );
  });

  it('keeps their numbers showing under it', () => {
    expect(markup.indexOf('data-slot="none-linked"')).toBeLessThan(
      markup.indexOf('<section aria-label="Followers"'),
    );
    expect(cards(markup)).toContain('Plays of every reel');
  });

  it('is not there once a reel is linked', () => {
    expect(render(falconInstagram())).not.toContain('data-slot="none-linked"');
  });

  it('is not there when no video can be linked (an editor’s view has no linkable videos)', () => {
    expect(render({ ...none, linkableJobs: [] })).not.toContain('data-slot="none-linked"');
  });

  it('comes after a scan problem when both are true', () => {
    const both = render({ ...none, lastScan: lastScan({ outcome: 'failed' }) });
    expect(both.indexOf('data-slot="scan-problem"')).toBeLessThan(
      both.indexOf('data-slot="none-linked"'),
    );
  });
});
