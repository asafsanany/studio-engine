import type { GraphicSummary } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeGraphicSummary } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { GraphicsList } from './GraphicsList';

const making = makeGraphicSummary({
  id: '000000000001',
  name: 'Hours saved counter',
  kind: 'callout',
  lengthSec: null,
  version: null,
  status: 'making',
  makingVersion: 1,
});
const ready = makeGraphicSummary({ id: '000000000002', name: 'Name on a white pill' });
const failed = makeGraphicSummary({
  id: '000000000003',
  name: 'Name with the client’s logo',
  status: 'failed',
  failedVersion: 3,
});
const hebrew = makeGraphicSummary({
  id: '000000000004',
  name: 'מיתוס או אמת – פתיחה',
  kind: 'title',
  lengthSec: 2.4,
});
const off = makeGraphicSummary({
  id: '000000000005',
  name: 'Follow card – first try',
  uses: false,
});

const LIBRARY: readonly GraphicSummary[] = [making, ready, failed, hebrew, off];

const actions = () => ({
  open: vi.fn(),
  rename: vi.fn(),
  duplicate: vi.fn(),
  reveal: vi.fn(),
  setUses: vi.fn(),
  retry: vi.fn(),
  remove: vi.fn(),
});

function list(props: Partial<React.ComponentProps<typeof GraphicsList>> = {}) {
  return renderAt(
    '/graphics',
    <GraphicsList graphics={LIBRARY} onNew={() => {}} actions={actions()} {...props} />,
  );
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The names of the rows, in the order they are on the page. */
const names = (html: string) =>
  [...html.matchAll(/data-slot="graphic-name"[^>]*>([^<]*)</g)].map((match) => match[1]);

describe('<GraphicsList> with graphics', () => {
  it('draws one row per graphic, in the order the engine gave them (newest change first)', async () => {
    const html = await list();
    expect(names(html)).toEqual([
      'Hours saved counter',
      'Name on a white pill',
      'Name with the client’s logo',
      'מיתוס או אמת – פתיחה',
      'Follow card – first try',
    ]);
    expect(html).toContain('data-slot="graphics-list"');
    expect(html).toMatch(/<ul[^>]*aria-label="Graphics"/);
  });

  it('shows how many graphics there are and how many are being made', async () => {
    const text = textOf(await list());
    expect(text).toContain('5 graphics');
    expect(text).toContain('1 being made');
  });

  it('says "1 graphic", and leaves "being made" out when none is', async () => {
    const text = textOf(await list({ graphics: [ready] }));
    expect(text).toContain('1 graphic');
    expect(text).not.toMatch(/\d+ graphics/);
    expect(text).not.toContain('being made');
  });

  it('has a search box with a name and a placeholder', async () => {
    const html = await list();
    expect(html).toMatch(/<input[^>]*type="search"[^>]*placeholder="Search"/);
    expect(html).toContain('>Search graphics<');
  });

  it('keeps only the graphics whose name has the search in it, and still counts them all', async () => {
    const html = await list({ defaultQuery: 'PILL' });
    expect(names(html)).toEqual(['Name on a white pill']);
    expect(html).toMatch(/<input[^>]*value="PILL"/);
    expect(textOf(html)).toContain('5 graphics');
  });

  it('finds a Hebrew name', async () => {
    expect(names(await list({ defaultQuery: 'אמת' }))).toEqual(['מיתוס או אמת – פתיחה']);
  });

  it('says "No graphic matches “…”." when the search leaves nothing, and draws no rows', async () => {
    const html = await list({ defaultQuery: 'zzz' });
    expect(html).toContain('No graphic matches “<bdi>zzz</bdi>”.');
    expect(names(html)).toEqual([]);
    expect(html).not.toContain('<ul');
    // The box stays, so the search can be changed.
    expect(html).toContain('type="search"');
  });

  it('draws rows in every state at once: spinner, failed mark with Retry, kinds and "off for edits"', async () => {
    const html = await list();
    expect(html).toContain('aria-label="Being made"');
    expect(html).toContain('aria-label="A version failed"');
    expect(html).toContain('aria-label="Retry v3"');
    expect(html.match(/aria-label="Retry/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Title"');
    expect(textOf(html)).toContain('off for edits');
  });

  it('has no Delete dialog open', async () => {
    const html = await list();
    expect(html).not.toContain('role="alertdialog"');
    expect(html).not.toContain('Delete “');
  });
});

describe('<GraphicsList> before and without an answer', () => {
  it('draws nothing at first for a list that is still loading (a fast load shows no skeleton)', async () => {
    const html = await list({ graphics: undefined });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-skeleton-row');
    expect(html).not.toContain('type="search"');
    expect(textOf(html)).not.toContain('graphics');
  });

  it('draws skeleton rows once the wait has been long enough, with one "Loading graphics…" for screen readers', async () => {
    const html = await list({ graphics: undefined, skeletonDelayMs: 0 });
    expect(html.match(/data-skeleton-row/g)).toHaveLength(8);
    expect(html.match(/Loading graphics…/g)).toHaveLength(1);
    expect(html).toContain('role="status"');
    expect(html).toContain('h-11');
  });

  it('says "Can’t reach the engine." with Try again when the first answer never came', async () => {
    const html = await list({ graphics: undefined, failed: true });
    expect(textOf(html)).toContain('Can’t reach the engine. Try again');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-skeleton-row');
  });

  it('keeps a list that has arrived even when `failed` is still set', async () => {
    const html = await list({ failed: true });
    expect(names(html)).toHaveLength(5);
    expect(textOf(html)).not.toContain('Can’t reach the engine.');
  });
});

describe('<GraphicsList> with no graphics', () => {
  it('is the empty state: a title, one line of what to do and New graphic, and no toolbar', async () => {
    const html = await list({ graphics: [] });
    const text = textOf(html);
    expect(text).toContain('No graphics yet');
    expect(text).toContain(
      'Ask for one in a chat: a title, a lower third, a number that counts up, an end card. Every edit can use what you make.',
    );
    expect(text).toContain('New graphic');
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain('<ul');
  });

  it('has New graphic enabled, and disabled while the engine can’t be reached', async () => {
    const opening = (html: string) =>
      html.match(/<button([^>]*)>(?:(?!<\/button>).)*New graphic<\/button>/s)?.[1] ?? '';
    expect(opening(await list({ graphics: [] }))).not.toContain(' disabled=""');
    expect(opening(await list({ graphics: [], canCreate: false }))).toContain(' disabled=""');
  });
});
