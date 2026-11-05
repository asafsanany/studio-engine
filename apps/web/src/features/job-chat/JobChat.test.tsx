import type { JobFeedItem } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JobChat } from './JobChat';
import { run } from './test-fixtures';

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

// A feed shaped like a generated job's (its own lines, shortened).
const FEED: JobFeedItem[] = [
  run({ id: 'L1', run: 'brief', outcome: 'succeeded', durationMs: 54_295 }),
  { id: 'L5-0', at: null, kind: 'text', text: 'I wrote edit/brief.json.' },
  run({ id: 'L30', run: 'generate', outcome: 'succeeded', durationMs: 2_401_516 }),
  run({ id: 'L1177', outcome: 'succeeded', durationMs: 3_006_153 }),
  {
    id: 'L1180-0',
    at: null,
    kind: 'text',
    text: "I'll start by loading the **video-use** skill, then look at the folder.",
  },
  {
    id: 'L1181-0',
    at: null,
    kind: 'tools',
    tools: [
      { id: 't1', tool: 'Skill', label: 'Opened the video-use skill', detail: null, state: 'done' },
      { id: 't2', tool: 'Bash', label: 'List job folder', detail: 'ls', state: 'done' },
    ],
  },
  {
    id: 'L1278-0-0',
    at: null,
    kind: 'images',
    images: [
      {
        name: 'L1278-0-0.png',
        label: 'Strip A',
        path: 'edit/verify/frames/strip-A.png',
        wide: true,
      },
      { name: 'L1468-0-0.png', label: 'J1', path: 'edit/verify/frames/J1.png', wide: false },
    ],
  },
  {
    id: 'L1600-0-cuts',
    at: null,
    kind: 'card',
    card: {
      type: 'cuts',
      totalSec: 35,
      cuts: [
        { source: 'A', startSec: 0, endSec: 3.03, beat: 'HOOK alert', quote: null, reason: null },
      ],
    },
  },
  {
    id: 'L1700-0-loudness',
    at: null,
    kind: 'card',
    card: { type: 'loudness', integratedLufs: -13.4, truePeakDb: -1.5, rangeLu: null },
  },
  run({
    id: 'L2957',
    run: 'round',
    round: 1,
    outcome: 'failed',
    error: 'Finished without a preview',
    notes: [
      {
        id: 'n1',
        jobId: 'j',
        round: 1,
        atSec: 6.6,
        kind: 'text',
        text: 'Say BUT louder, then pause.',
        audioFile: null,
        audioSec: null,
        transcriptStatus: null,
        addToStyle: false,
        addToSeries: false,
        createdAt: '2026-10-25T21:50:00.000Z',
        sentAt: '2026-10-25T21:51:00.000Z',
      } as never,
    ],
  }),
];

describe('JobChat', () => {
  const html = renderToStaticMarkup(<JobChat jobId="2e16abbe0c68" items={FEED} />);
  const text = textOf(html);

  it('folds the Brief and Generate under one line, and opens with the Draft', () => {
    expect(text).toContain('Made the footage first · 41 min');
    expect(text).not.toContain('I wrote edit/brief.json.');
    expect(text.indexOf('Made the footage first')).toBeLessThan(text.indexOf('Draft started'));
  });

  it('shows Claude’s words with its bold, its commands folded and the pictures it opened', () => {
    expect(html).toContain('<strong class="font-semibold text-foreground">video-use</strong>');
    expect(text).toContain('Ran 2 commands · List job folder');
    expect(text).not.toContain('Opened the video-use skill');
    expect(html).toContain('src="/api/jobs/2e16abbe0c68/feed/img/L1278-0-0.png"');
    expect(text).toContain('Strip A · edit/verify/frames/strip-A.png');
    expect(html).toContain('aria-label="Open: J1"');
  });

  it('shows the cards and how long the Draft took', () => {
    expect(text).toContain('Cut list 1 shot · 35.0 s');
    expect(text).toContain('HOOK alert');
    expect(text).toContain('Mix −13.4 LUFS');
    expect(text).toContain('Draft took 50 min');
  });

  it('shows a round with the notes it was sent, and why it failed', () => {
    expect(text).toContain('Round 1 You · 1 note 0:06.6 Say BUT louder, then pause.');
    expect(text).toContain('Couldn’t finish this run Finished without a preview');
    expect(text).toContain('Copy error');
  });

  it('shows what it is doing while it runs, and what to show when nothing has started', () => {
    const live = textOf(renderToStaticMarkup(<JobChat jobId="j" items={FEED.slice(3, 6)} live />));
    expect(live).toContain('List job folder');
    const empty = renderToStaticMarkup(
      <JobChat jobId="j" items={[]} empty={<p>Nothing here yet</p>} />,
    );
    expect(empty).toContain('Nothing here yet');
  });
});
