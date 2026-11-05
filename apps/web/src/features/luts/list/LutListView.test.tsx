import type { LutListResponse } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeBuiltInLutSummary, makeLutSummary } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { LutListView } from './LutList';
import type { LutActions } from './lut-actions';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

const golden = makeLutSummary();
const fresh = makeLutSummary({
  slug: 'soft-pastel',
  name: 'Soft Pastel',
  used: 0,
  usedLabel: 'Not used yet',
  addedAt: new Date(NOW - 5 * 60_000).toISOString(),
  isNew: true,
});
const sony = makeLutSummary({
  slug: 'sony-s-log3-to-rec709',
  name: 'Sony S-Log3 to Rec709',
  kind: 'camera',
  size: 65,
});
const cinematic = makeBuiltInLutSummary({ slug: 'cinematic', name: 'Cinematic' });
const film = makeBuiltInLutSummary();
const redSkin = makeBuiltInLutSummary({ slug: 'red-skin-fix', name: 'Red skin fix', kind: 'fix' });

const LIST: LutListResponse = {
  yours: [fresh, golden, sony],
  builtIn: [cinematic, film, redSkin],
  builtInAvailable: true,
};

const actions = (): LutActions => ({
  rename: vi.fn(),
  duplicate: vi.fn(),
  reveal: vi.fn(),
  copyToken: vi.fn(),
  remove: vi.fn(),
});

function view(props: Partial<React.ComponentProps<typeof LutListView>> = {}) {
  return renderAt(
    '/luts',
    <LutListView
      list={LIST}
      selected={null}
      onSelect={() => {}}
      onImport={() => {}}
      tab="all"
      onTab={() => {}}
      lutsInEdits={true}
      actions={actions()}
      now={NOW}
      {...props}
    />,
  );
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The names of the rows, in the order they are on the page. */
const names = (html: string) =>
  [...html.matchAll(/data-slot="lut-name"[^>]*>([^<]*)</g)].map((match) => match[1]);

/** The slugs of the rows, in order. */
const slugs = (html: string) => [...html.matchAll(/data-lut-slug="([^"]*)"/g)].map((m) => m[1]);

const headings = (html: string) =>
  [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)].map((match) => textOf(match[1] ?? ''));

describe('<LutListView> sections', () => {
  it('draws Yours (newest first) then Built in (by name), each under its heading with a count', async () => {
    const html = await view();
    expect(headings(html)).toEqual(['Yours 3', 'Built in 3']);
    expect(names(html)).toEqual([
      'Soft Pastel',
      'Golden Hour Warm',
      'Sony S-Log3 to Rec709',
      'Cinematic',
      'Film contrast',
      'Red skin fix',
    ]);
    expect(html).toContain('aria-label="LUTs"');
  });

  it('is text only: no pictures in the rows', async () => {
    const html = await view();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<canvas');
  });

  it('opens the first row when none is selected, and the selected one when it is shown', async () => {
    expect(slugs(await view())).toHaveLength(6);
    const first = await view({ selected: null });
    expect(first).toMatch(/data-lut-slug="soft-pastel"[^>]*data-selected="true"/);
    const picked = await view({ selected: 'film-contrast' });
    expect(picked).toMatch(/data-lut-slug="film-contrast"[^>]*data-selected="true"/);
    expect(picked).toMatch(/data-lut-slug="soft-pastel"[^>]*data-selected="false"/);
    const gone = await view({ selected: 'nothing-like-it' });
    expect(gone).toMatch(/data-lut-slug="soft-pastel"[^>]*data-selected="true"/);
  });

  it('marks only an import from the last 30 minutes with the New tag', async () => {
    const html = await view();
    expect(html.match(/data-slot="lut-new"/g)).toHaveLength(1);
  });
});

describe('<LutListView> tabs', () => {
  it('draws the four tabs with their counts over the whole library', async () => {
    const html = await view();
    expect(textOf(html)).toContain('All 6 Looks 4 Camera 1 Fixes 1');
    expect(html).toContain('aria-label="Kind"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toMatch(/aria-selected="true"[^>]*data-state="active"[^>]*>All</);
  });

  it('shows the picked tab as active and only that kind’s rows', async () => {
    const html = await view({ tab: 'camera' });
    expect(html).toMatch(/aria-selected="true"[^>]*data-state="active"[^>]*>Camera</);
    expect(names(html)).toEqual(['Sony S-Log3 to Rec709']);
    expect(headings(html)).toEqual(['Yours 1']);
    const fixes = await view({ tab: 'fix' });
    expect(names(fixes)).toEqual(['Red skin fix']);
    expect(headings(fixes)).toEqual(['Built in 1']);
  });

  it('keeps the counts when a tab is picked, and shows no hint on a kind tab', async () => {
    const html = await view({ tab: 'fix', list: { ...LIST, yours: [] } });
    expect(textOf(html)).toContain('All 3 Looks 2 Camera 0 Fixes 1');
    expect(textOf(html)).not.toContain('Nothing imported yet');
  });
});

describe('<LutListView> search', () => {
  it('has a search box with its own label', async () => {
    const html = await view();
    expect(html).toContain('type="search"');
    expect(html).toContain('Search LUTs');
    expect(html).toContain('w-55');
  });

  it('filters by name', async () => {
    const html = await view({ defaultQuery: 'film' });
    expect(names(html)).toEqual(['Film contrast']);
    expect(headings(html)).toEqual(['Built in 1']);
  });

  it('filters by file name', async () => {
    expect(names(await view({ defaultQuery: 'Hour Warm.cube' }))).toEqual(['Golden Hour Warm']);
    expect(names(await view({ defaultQuery: 'film_contrast' }))).toEqual(['Film contrast']);
  });

  it('says "No LUT matches “…”." when nothing is left, with no headings', async () => {
    const html = await view({ defaultQuery: 'zzz' });
    expect(textOf(html)).toContain('No LUT matches “zzz”.');
    expect(names(html)).toEqual([]);
    expect(headings(html)).toEqual([]);
  });

  it('does not change the tab counts', async () => {
    const html = await view({ defaultQuery: 'film' });
    expect(textOf(html)).toContain('All 6 Looks 4 Camera 1 Fixes 1');
  });
});

describe('<LutListView> empty and special states', () => {
  const noneYours: LutListResponse = { ...LIST, yours: [] };

  it('shows the hint under Yours when nothing is imported (All, no search)', async () => {
    const html = await view({ list: noneYours });
    expect(headings(html)).toEqual(['Yours 0', 'Built in 3']);
    expect(textOf(html)).toContain(
      'Nothing imported yet. Drop .cube files anywhere on this page, or use Import LUTs .',
    );
    expect(html).toMatch(/<button[^>]*>Import LUTs<\/button>/);
  });

  it('disables the hint’s Import LUTs while the engine can’t be reached', async () => {
    const html = await view({ list: noneYours, canImport: false });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import LUTs<\/button>/);
  });

  it('shows no hint while searching', async () => {
    const html = await view({ list: noneYours, defaultQuery: 'film' });
    expect(textOf(html)).not.toContain('Nothing imported yet');
    expect(headings(html)).toEqual(['Built in 1']);
  });

  it('shows the one line under Built in while the colour grade is not installed', async () => {
    const html = await view({ list: { yours: [golden], builtIn: [], builtInAvailable: false } });
    expect(headings(html)).toEqual(['Yours 1', 'Built in']);
    expect(textOf(html)).toContain(
      'Built-in LUTs need the colour grade. Run pnpm color-grade:install.',
    );
  });

  it('shows both hints for a new library without the colour grade', async () => {
    const html = await view({ list: { yours: [], builtIn: [], builtInAvailable: false } });
    expect(textOf(html)).toContain('Nothing imported yet.');
    expect(textOf(html)).toContain('Built-in LUTs need the colour grade.');
  });

  it('says a kind tab is empty when it has nothing and no search', async () => {
    const html = await view({
      tab: 'camera',
      list: { ...LIST, yours: [golden] },
    });
    expect(textOf(html)).toContain('Nothing in this tab yet.');
  });
});

describe('<LutListView> before and without an answer', () => {
  it('draws nothing at first for a list that is still loading (a fast load shows no skeleton)', async () => {
    const html = await view({ list: undefined });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-skeleton-row');
    expect(textOf(html)).not.toContain('Yours');
    expect(html).not.toContain('data-slot="lut-tab-count"');
  });

  it('draws skeleton rows once the wait has been long enough, with one "Loading LUTs…" for screen readers', async () => {
    const html = await view({ list: undefined, skeletonDelayMs: 0 });
    expect(html.match(/data-skeleton-row/g)).toHaveLength(8);
    expect(html.match(/Loading LUTs…/g)).toHaveLength(1);
    expect(html).toContain('h-11');
  });

  it('says "Can’t reach the engine." with Try again when the first answer never came', async () => {
    const html = await view({ list: undefined, failed: true });
    expect(textOf(html)).toContain('Can’t reach the engine. Try again');
    expect(html).toContain('role="alert"');
  });

  it('keeps a list that has arrived even when `failed` is still set (offline keeps the last list)', async () => {
    const html = await view({ failed: true });
    expect(names(html)).toHaveLength(6);
    expect(textOf(html)).not.toContain('Can’t reach the engine.');
  });
});

describe('<LutListView> menu words', () => {
  it('is wired to the lutsInEdits switch (the Delete dialog stays closed until asked)', async () => {
    const html = await view({ lutsInEdits: false });
    expect(html).not.toContain('Delete “');
  });
});
