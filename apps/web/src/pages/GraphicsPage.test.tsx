import type { GraphicSummary } from '@studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeGraphicSummary } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';

// What the page reads: the graphics query (a test sets what it answers) and whether the engine
// can be reached (the phone's watch, which the Mac page now reads too).
const query: {
  data: GraphicSummary[] | undefined;
  isError: boolean;
  failureCount: number;
  refetch: () => void;
} = { data: undefined, isError: false, failureCount: 0, refetch: () => {} };
const engine = { offline: false, heardAt: null as number | null };

vi.mock('@/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data')>()),
  useGraphics: () => query,
}));
vi.mock('@/features/phone/use-engine-offline', () => ({
  useEngineOffline: () => engine.offline,
  useEngineLastHeard: () => engine.heardAt,
}));

const { GraphicsPage } = await import('./GraphicsPage');

const library = [
  makeGraphicSummary({
    id: '000000000001',
    name: 'Hours saved counter',
    kind: 'callout',
    lengthSec: null,
    version: null,
    status: 'making',
    makingVersion: 1,
  }),
  makeGraphicSummary({ id: '000000000002', name: 'Name on a white pill' }),
];

const page = (props: { skeletonDelayMs?: number } = {}) =>
  renderAt('/graphics', <GraphicsPage {...props} />);

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The opening tag's attributes of the header's New graphic button (the first one on the page). */
const newGraphicAttrs = (html: string) =>
  html.match(/<button([^>]*)>(?:(?!<\/button>).)*New graphic<\/button>/s)?.[1] ?? '';

beforeEach(() => {
  query.data = library;
  query.isError = false;
  query.failureCount = 0;
  engine.offline = false;
  engine.heardAt = null;
});

describe('<GraphicsPage>', () => {
  it('has the heading, the line under it and a New graphic button', async () => {
    const html = await page();
    expect(html).toMatch(/<h1[^>]*>Graphics<\/h1>/);
    expect(textOf(html)).toContain('Ask for a graphic in a chat. Every edit can use what’s here.');
    expect(newGraphicAttrs(html)).not.toContain(' disabled=""');
    expect(html).toContain('lucide-plus');
  });

  it('lists the graphics under a toolbar with the count and how many are being made', async () => {
    const html = await page();
    expect(html).toContain('data-slot="graphics-list"');
    expect(textOf(html)).toContain('2 graphics');
    expect(textOf(html)).toContain('1 being made');
    expect(html).toContain('Name on a white pill');
    expect(html).not.toContain('role="status"');
  });

  it('is the empty state with no graphics', async () => {
    query.data = [];
    const html = await page();
    expect(textOf(html)).toContain('No graphics yet');
    // The header's button and the empty state's own.
    expect(html.match(/New graphic<\/button>/g)).toHaveLength(2);
  });

  it('draws nothing but the heading until the first answer, then skeleton rows after the wait', async () => {
    query.data = undefined;
    expect(await page()).not.toContain('data-skeleton-row');
    expect(await page({ skeletonDelayMs: 0 })).toContain('data-skeleton-row');
  });

  it('says "Can’t reach the engine." with Try again, and waits on New graphic, when the list never arrived', async () => {
    query.data = undefined;
    query.failureCount = 1;
    const html = await page();
    expect(textOf(html)).toContain('Can’t reach the engine. Try again');
    expect(newGraphicAttrs(html)).toContain(' disabled=""');
    // The banner says "as it was": there is no list to say it of.
    expect(html).not.toContain('This is the list as it was');
  });
});

describe('<GraphicsPage> when the engine can’t be reached', () => {
  it('keeps the list, says so in a bar above the page, and disables New graphic', async () => {
    engine.offline = true;
    engine.heardAt = new Date(2026, 9, 22, 10, 42).getTime();
    const html = await page();
    expect(textOf(html)).toContain(
      'Can’t reach the engine on your Mac. This is the list as it was at 10:42. New graphic waits until it’s back.',
    );
    expect(html.indexOf('Can’t reach the engine on your Mac')).toBeLessThan(html.indexOf('<h1'));
    expect(html).toContain('Name on a white pill');
    expect(newGraphicAttrs(html)).toContain(' disabled=""');
  });

  it('disables the empty state’s New graphic too', async () => {
    engine.offline = true;
    query.data = [];
    const html = await page();
    const buttons = [
      ...html.matchAll(/<button([^>]*)>(?:(?!<\/button>).)*New graphic<\/button>/gs),
    ];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button[1]).toContain(' disabled=""');
  });

  it('is back to normal when the engine answers', async () => {
    engine.offline = false;
    const html = await page();
    expect(html).not.toContain('Can’t reach the engine on your Mac');
    expect(newGraphicAttrs(html)).not.toContain(' disabled=""');
  });
});
