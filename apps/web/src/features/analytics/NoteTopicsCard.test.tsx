import type { AnalyticsReviews } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { CHART_BLUE } from './charts/chart-colors';
import { NoteTopicsCard } from './NoteTopicsCard';

function reviews(overrides: Partial<AnalyticsReviews>): AnalyticsReviews {
  return { ...makeAnalyticsResponse().reviews, ...overrides };
}

const ranked: AnalyticsReviews['noteTopics'] = [
  {
    topic: 'intro too long',
    count: 8,
    clients: [
      { client: 'Kova Coffee', count: 4 },
      { client: 'Arc Fitness', count: 3 },
      { client: 'Lumen Yoga', count: 1 },
    ],
  },
  {
    topic: 'logo late',
    count: 4,
    clients: [
      { client: 'Arc Fitness', count: 2 },
      { client: 'מאפיית הצפון', count: 2 },
    ],
  },
  { topic: 'volume dip', count: 2, clients: [{ client: 'מרפאת מירה', count: 2 }] },
];

describe('<NoteTopicsCard> with topics', () => {
  const markup = renderToStaticMarkup(
    <NoteTopicsCard
      reviews={reviews({ noteTopics: ranked, notGroupedYet: 3, notesSince: '2026-09-03' })}
    />,
  );

  it('is the card of the board: its title, 500 px tall, half the row', () => {
    expect(markup).toContain('aria-label="What your notes are about"');
    expect(markup).toContain('>What your notes are about</h3>');
    expect(markup).toContain('h-[500px]');
    expect(markup).toContain('min-[1000px]:col-span-3');
  });

  it('names the month of the first note in the subtitle', () => {
    expect(markup).toContain(
      '>Your review notes since September, most common first, with who got them</p>',
    );
  });

  it('is a row per topic in the order it is given, each with its topic, its bar and its count', () => {
    const rows = markup.split('<li ').slice(1);
    expect(rows).toHaveLength(3);
    const topics = rows.map((row) => row.match(/text-zinc-300">([^<]+)</)?.[1]);
    expect(topics).toEqual(['intro too long', 'logo late', 'volume dip']);
    const counts = rows.map((row) => row.match(/tabular-nums">(\d+)</)?.[1]);
    expect(counts).toEqual(['8', '4', '2']);
  });

  it('lays each row out as topic, bar and count in a 132 px / flexible / 24 px grid', () => {
    expect(markup.match(/grid-cols-\[132px_minmax\(0,1fr\)_24px\]/g)).toHaveLength(3);
    expect(markup.match(/gap-2\.5/g)).toHaveLength(3);
  });

  it('draws the bars in blue against the biggest topic', () => {
    const widths = [...markup.matchAll(/style="width:([\d.]+)%;background-color:([^"]+)"/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(widths).toEqual([
      ['100', CHART_BLUE],
      ['50', CHART_BLUE],
      ['25', CHART_BLUE],
    ]);
  });

  it('names the clients under each bar in muted text that reads in its own direction, Hebrew untouched', () => {
    expect(markup).toContain('>Kova Coffee, Arc Fitness, Lumen Yoga</span>');
    expect(markup).toContain('>Arc Fitness, מאפיית הצפון</span>');
    expect(markup).toContain('>מרפאת מירה</span>');
    const clientSpans = markup.match(/<span dir="auto" class="[^"]*">/g) ?? [];
    expect(clientSpans).toHaveLength(3);
    for (const span of clientSpans) {
      expect(span).toContain('text-muted-foreground');
      expect(span).toContain('[unicode-bidi:plaintext]');
      expect(span).toContain('truncate');
      // As on the board (N3): aligned to the start of its own direction, so a Hebrew line sits at
      // the right and an English one at the left. Never a fixed left alignment.
      expect(span).toContain('text-start');
      expect(span).not.toContain('text-left');
    }
  });

  it('makes each row a hover target, whose card keeps its counts (note-topics-view)', () => {
    expect(markup.match(/<li [^>]*data-slot="tooltip-trigger"/g)).toHaveLength(
      markup.match(/<li /g)?.length ?? -1,
    );
  });

  it('ends with the muted line about notes without a topic, after the last row', () => {
    expect(markup).toContain('>3 notes not grouped yet</p>');
    expect(markup.indexOf('not grouped yet')).toBeGreaterThan(markup.lastIndexOf('</li>'));
    expect(markup).toMatch(/<p class="[^"]*text-xs[^"]*text-muted-foreground[^"]*">3 notes/);
  });

  it('scrolls the rows, not the card, when there are more than fit', () => {
    expect(markup).toContain('overflow-y-auto');
  });

  it('is read-only', () => {
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
  });
});

describe('<NoteTopicsCard> when every note has a topic', () => {
  it('leaves out the line about notes without a topic', () => {
    const markup = renderToStaticMarkup(
      <NoteTopicsCard reviews={reviews({ noteTopics: ranked, notGroupedYet: 0 })} />,
    );
    expect(markup).not.toContain('not grouped yet');
  });

  it('says "1 note" for one', () => {
    const markup = renderToStaticMarkup(
      <NoteTopicsCard reviews={reviews({ noteTopics: ranked, notGroupedYet: 1 })} />,
    );
    expect(markup).toContain('>1 note not grouped yet</p>');
  });
});

describe('<NoteTopicsCard> with notes but no topics yet', () => {
  const markup = renderToStaticMarkup(
    <NoteTopicsCard reviews={reviews({ notGroupedYet: 9, notesSince: '2026-10-20' })} />,
  );

  it('says how many notes are not grouped yet, and draws no rows', () => {
    expect(markup).toContain('>9 notes not grouped yet</p>');
    expect(markup).not.toContain('<li');
    expect(markup).not.toContain('No review notes yet');
    expect(markup).not.toContain('No data yet');
  });

  it('still names the month of the first note', () => {
    expect(markup).toContain('>Your review notes since October, most common first');
  });
});

describe('<NoteTopicsCard> with no note sent', () => {
  const markup = renderToStaticMarkup(<NoteTopicsCard reviews={makeAnalyticsResponse().reviews} />);

  it('says "No review notes yet" and nothing else', () => {
    expect(markup).toContain('>No review notes yet</p>');
    expect(markup).not.toContain('<li');
    expect(markup).not.toContain('not grouped yet');
    expect(markup).not.toContain('No data yet');
  });

  it('keeps the card’s title and the subtitle without a month', () => {
    expect(markup).toContain('>What your notes are about</h3>');
    expect(markup).toContain('>Your review notes, most common first, with who got them</p>');
  });
});
