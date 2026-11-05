import type { FontFamilySummary } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeFontFamilySummary } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { FontListView } from './FontList';
import { OfflineFontsBanner } from './FontListStates';
import type { FontActions } from './font-actions';
import { makeRealFamilies } from './real-families-fixture';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const REAL = makeRealFamilies();

const actions = (): FontActions => ({
  reveal: vi.fn(),
  copyToken: vi.fn(),
  remove: vi.fn(),
});

function view(props: Partial<React.ComponentProps<typeof FontListView>> = {}) {
  return renderAt(
    '/fonts',
    <FontListView
      families={REAL}
      selected={null}
      onSelect={() => {}}
      onImport={() => {}}
      tab="all"
      onTab={() => {}}
      actions={actions()}
      inNotes
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
  [...html.matchAll(/data-slot="font-name"[^>]*>([^<]*)</g)].map((match) => match[1]);

/** The slugs of the rows, in order. */
const slugs = (html: string) => [...html.matchAll(/data-font-slug="([^"]*)"/g)].map((m) => m[1]);

/** The classes of the search box's wrapper (the div that holds the magnifier and the field). */
const searchBoxClasses = (html: string) =>
  html.match(/<div class="([^"]*)"><svg[^>]*lucide-search/)?.[1] ?? '';

const rowOf = (html: string, slug: string) =>
  html.match(new RegExp(`<li[^>]*data-font-slug="${slug}"[^>]*>`))?.[0] ?? '';

describe('<FontListView> rows', () => {
  it('draws one quiet row per family, A to Z, in a list labelled Fonts', async () => {
    const html = await view();
    const drawn = names(html);
    expect(drawn).toHaveLength(40);
    expect(drawn[0]).toBe('Alef');
    expect(drawn.at(-1)).toBe('Work Sans');
    expect(drawn).toEqual(
      [...drawn].sort((a, b) =>
        (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base' }),
      ),
    );
    expect(html).toContain('aria-label="Fonts"');
    expect(html).toContain('data-slot="font-list"');
  });

  it('is text only: no pictures in the rows', async () => {
    const html = await view();
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<canvas');
    expect(html).not.toContain('font-family');
  });

  it('opens the first row when none is selected, and the selected one when it is shown', async () => {
    const first = await view({ selected: null });
    expect(rowOf(first, 'alef')).toContain('data-selected="true"');
    expect(first.match(/data-selected="true"/g)).toHaveLength(1);
    const picked = await view({ selected: 'heebo' });
    expect(rowOf(picked, 'heebo')).toContain('data-selected="true"');
    expect(rowOf(picked, 'alef')).toContain('data-selected="false"');
    expect(picked.match(/data-selected="true"/g)).toHaveLength(1);
  });

  it('opens the first row when the selected family is gone or hidden by the tab', async () => {
    const gone = await view({ selected: 'nothing-like-it' });
    expect(rowOf(gone, 'alef')).toContain('data-selected="true"');
    const hidden = await view({ selected: 'heebo', tab: 'en' });
    expect(rowOf(hidden, 'dm-sans')).toContain('data-selected="true"');
  });

  it('puts New families on top with the New tag, and only for the last 30 minutes', async () => {
    const families = [
      ...REAL,
      makeFontFamilySummary({
        slug: 'karantina',
        name: 'Karantina',
        weights: [300, 400, 700],
        weightsLabel: '3 weights',
        used: 0,
        usedLabel: 'Not used yet',
        addedAt: minutesAgo(2),
        isNew: true,
      }),
      // The server called it new when it answered; half an hour on this page it no longer is.
      makeFontFamilySummary({
        slug: 'bebas-neue',
        name: 'Bebas Neue',
        he: false,
        weights: [400],
        weightsLabel: '1 weight',
        addedAt: minutesAgo(45),
        isNew: true,
      }),
    ];
    const html = await view({ families });
    expect(names(html).slice(0, 3)).toEqual(['Karantina', 'Alef', 'Amatic SC']);
    expect(html.match(/data-slot="font-new"/g)).toHaveLength(1);
    expect(rowOf(html, 'karantina')).toBeTruthy();
    expect(
      textOf(
        html.slice(
          html.indexOf('data-font-slug="karantina"'),
          html.indexOf('data-font-slug="alef"'),
        ),
      ),
    ).toContain('New');
    expect(textOf(html)).toContain('2 min ago');
  });
});

describe('<FontListView> while notes cannot name a font yet', () => {
  it('draws no used column: every row would say "Not used yet"', async () => {
    const html = await view({ inNotes: false });
    expect(names(html)).toHaveLength(40);
    expect(html).not.toContain('data-slot="font-used"');
    expect(textOf(html)).not.toContain('Not used yet');
    expect(textOf(html)).not.toContain('14 jobs');
    expect(html).toContain('grid-cols-[16px_minmax(0,1fr)_124px_84px_84px]');
  });

  it('draws the used column once notes can name a font', async () => {
    const html = await view({ inNotes: true });
    expect(html.match(/data-slot="font-used"/g)).toHaveLength(40);
    expect(textOf(html)).toContain('14 jobs');
  });
});

describe('<FontListView> tabs', () => {
  it('draws the three tabs with their counts over the whole library: 40 · 20 · 20', async () => {
    const html = await view();
    expect(textOf(html)).toContain('All 40 Hebrew + English 20 English only 20');
    expect(html).toContain('aria-label="Script"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-selected="true"[^>]*data-state="active"[^>]*><span[^>]*>All</);
  });

  it('shows the Hebrew + English tab as active and only its 20 families', async () => {
    const html = await view({ tab: 'he' });
    expect(html).toMatch(
      /aria-selected="true"[^>]*data-state="active"[^>]*><span[^>]*>Hebrew \+ English</,
    );
    expect(names(html)).toHaveLength(20);
    expect(names(html)).toContain('Heebo');
    expect(names(html)).not.toContain('Poppins');
  });

  it('shows the English only tab as active and only its 20 families', async () => {
    const html = await view({ tab: 'en' });
    expect(html).toMatch(
      /aria-selected="true"[^>]*data-state="active"[^>]*><span[^>]*>English only</,
    );
    expect(names(html)).toHaveLength(20);
    expect(names(html)).toContain('Poppins');
    expect(names(html)).not.toContain('Heebo');
  });

  it('keeps the counts when a tab is picked or a search is typed', async () => {
    expect(textOf(await view({ tab: 'he' }))).toContain(
      'All 40 Hebrew + English 20 English only 20',
    );
    expect(textOf(await view({ defaultQuery: 'heebo' }))).toContain(
      'All 40 Hebrew + English 20 English only 20',
    );
  });
});

describe('<FontListView> search', () => {
  it('has a search box with its own label, up to 220 px wide', async () => {
    const html = await view();
    expect(html).toContain('type="search"');
    expect(html).toContain('Search fonts');
    expect(html).toContain('placeholder="Search"');
    expect(searchBoxClasses(html)).toContain('max-w-55');
  });

  // CVP-367 (C49): with the pane open the list is 552 px at 1280, and the tabs (331 px, 356 px with
  // the real library's two-digit counts) plus a fixed 220 px box ran 11 to 36 px past it, under the
  // pane's border. The box now takes what the tabs leave, 144 px at the least. The row's real
  // widths are in e2e/fonts.spec.ts; here the box must carry the classes that do it.
  it('is flexible: it takes the width the tabs leave on their row, from 144 px up to 220 px', async () => {
    const html = await view();
    const classes = searchBoxClasses(html).split(/\s+/);
    // grows to the free width, up to the board's 220 px, and no further
    expect(classes).toContain('flex-1');
    expect(classes).toContain('max-w-55');
    // it can narrow to 144 px, and 144 px is also the size the row wraps on (never earlier)
    expect(classes).toContain('min-w-36');
    expect(classes).toContain('basis-36');
    // never a fixed 220 px that cannot give way
    expect(classes).not.toContain('w-55');
    expect(classes).not.toContain('flex-none');
  });

  it('starts with what it is given and filters by the family name', async () => {
    const html = await view({ defaultQuery: 'roboto' });
    expect(names(html)).toEqual(['Roboto', 'Roboto Condensed', 'Roboto Slab']);
    expect(html).toContain('value="roboto"');
  });

  it('filters inside the tab', async () => {
    expect(names(await view({ defaultQuery: 'noto', tab: 'he' }))).toEqual(['Noto Sans Hebrew']);
  });

  it('opens the first match when the open family is not one', async () => {
    const html = await view({ defaultQuery: 'roboto', selected: 'heebo' });
    expect(rowOf(html, 'roboto')).toContain('data-selected="true"');
  });

  it('says "No font matches “…”." when nothing is left', async () => {
    const html = await view({ defaultQuery: 'Gotham' });
    expect(textOf(html)).toContain('No font matches “Gotham”.');
    expect(names(html)).toEqual([]);
    expect(html).not.toContain('<ul');
  });

  it('says "No font matches" for a search the tab hides, too', async () => {
    const html = await view({ defaultQuery: 'heebo', tab: 'en' });
    expect(textOf(html)).toContain('No font matches “heebo”.');
  });

  it('says a tab is empty when it has nothing and there is no search', async () => {
    const onlyEnglish = REAL.filter((family) => !family.he);
    const html = await view({ families: onlyEnglish, tab: 'he' });
    expect(textOf(html)).toContain('Nothing in this tab yet.');
    expect(textOf(html)).toContain('All 20 Hebrew + English 0 English only 20');
  });
});

describe('<FontListView> an empty library', () => {
  it('shows the hint row, with Import fonts as a link, and no rows', async () => {
    const html = await view({ families: [] });
    expect(textOf(html)).toContain(
      'No fonts yet. Drop .ttf or .otf files anywhere on this page, or use Import fonts .',
    );
    expect(html).toMatch(/<button[^>]*>Import fonts<\/button>/);
    expect(slugs(html)).toEqual([]);
    expect(textOf(html)).toContain('All 0 Hebrew + English 0 English only 0');
  });

  it('shows the hint even when something is typed in the search', async () => {
    const html = await view({ families: [], defaultQuery: 'heebo' });
    expect(textOf(html)).toContain('No fonts yet.');
    expect(textOf(html)).not.toContain('No font matches');
  });

  it('disables the hint’s Import fonts while the engine can’t be reached', async () => {
    const html = await view({ families: [], canImport: false });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import fonts<\/button>/);
  });
});

describe('<FontListView> before and without an answer', () => {
  it('draws nothing at first for a list that is still loading (a fast load shows no skeleton)', async () => {
    const html = await view({ families: undefined });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-skeleton-row');
    expect(html).not.toContain('data-slot="font-tab-count"');
    expect(html).not.toContain('No fonts yet.');
  });

  it('draws skeleton rows once the wait has been long enough, with one "Loading fonts…" for screen readers', async () => {
    const html = await view({ families: undefined, skeletonDelayMs: 0 });
    expect(html.match(/data-skeleton-row/g)).toHaveLength(10);
    expect(html.match(/Loading fonts…/g)).toHaveLength(1);
    expect(html).toContain('h-11');
  });

  it('leaves the used bar out of the skeleton rows while notes cannot name a font yet', async () => {
    const withUsed = await view({ families: undefined, skeletonDelayMs: 0 });
    const without = await view({ families: undefined, skeletonDelayMs: 0, inNotes: false });
    expect(without.match(/data-slot="skeleton"/g)?.length).toBe(
      (withUsed.match(/data-slot="skeleton"/g)?.length ?? 0) - 10,
    );
    expect(without).toContain('grid-cols-[16px_minmax(0,1fr)_124px_84px_84px]');
  });

  it('waits 250 ms by default before the skeleton', async () => {
    const { SKELETON_DELAY_MS } = await import('@/features/jobs/delayed-flag');
    expect(SKELETON_DELAY_MS).toBe(250);
  });

  it('says "Can’t reach the engine." with Try again when the first answer never came', async () => {
    const html = await view({ families: undefined, failed: true });
    expect(textOf(html)).toContain('Can’t reach the engine. Try again');
    expect(html).toContain('role="alert"');
  });

  it('keeps a list that has arrived even when `failed` is still set', async () => {
    const html = await view({ failed: true });
    expect(names(html)).toHaveLength(40);
    expect(textOf(html)).not.toContain('Can’t reach the engine.');
  });
});

describe('<FontListView> the engine is away', () => {
  it('draws no bar of its own: the page shows it above both columns', async () => {
    const html = await view();
    expect(html).not.toContain('role="status"');
    expect(textOf(html)).not.toContain('on your Mac');
  });

  it('still says "Can’t reach the engine." with Try again when the first answer never came', async () => {
    const html = await view({ families: undefined, failed: true });
    expect(textOf(html)).not.toContain('on your Mac');
    expect(textOf(html)).toContain('Can’t reach the engine. Try again');
  });
});

describe('<OfflineFontsBanner>', () => {
  it('says when the list was last right, and that importing waits', async () => {
    const heardAt = new Date(2026, 9, 24, 10, 42).getTime();
    const html = await renderAt('/fonts', <OfflineFontsBanner heardAt={heardAt} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-slot="fonts-offline-banner"');
    expect(textOf(html)).toContain(
      'Can’t reach the engine on your Mac. This is the list as it was at 10:42. Importing waits until it’s back.',
    );
  });

  it('leaves the time out when the engine never answered', async () => {
    const html = await renderAt('/fonts', <OfflineFontsBanner heardAt={null} />);
    expect(textOf(html)).toContain(
      'Can’t reach the engine on your Mac. Importing waits until it’s back.',
    );
  });
});

describe('<FontListView> the delete dialog', () => {
  it('stays closed until Delete… is chosen', async () => {
    const html = await view();
    expect(html).not.toContain('Delete “');
  });
});

describe('<FontListView> names', () => {
  it('lets a Hebrew family name pick its own reading direction', async () => {
    const families: FontFamilySummary[] = [
      makeFontFamilySummary({ slug: 'font-3fa9c1', name: 'דוד' }),
    ];
    const html = await view({ families });
    expect(html).toMatch(/<button[^>]*dir="auto"[^>]*>דוד</);
  });
});

// CVP-366 (C48): the list answers to its OWN width, not the window's, because the open pane takes
// 440 px of it. The queries run in the browser (e2e/fonts.spec.ts looks at a 1024 px window); here
// the list must be the container they ask, and the parts around the rows must carry their limits.
describe('<FontListView> in a narrow window', () => {
  it('is the container its rows and controls answer to', async () => {
    const html = await view();
    const root = html.match(/<div[^>]*data-slot="font-list"[^>]*>/)?.[0] ?? '';
    expect(root).toMatch(/class="(?:[^"]*\s)?@container[\s"]/);
  });

  it('wraps the tabs and the search onto two lines under 530 px, and drops the tab counts under 400 px', async () => {
    const html = await view();
    expect(html).toContain('@max-[530px]:flex-wrap');
    const counts = [...html.matchAll(/<span[^>]*data-slot="font-tab-count"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(counts).toHaveLength(3);
    for (const tag of counts) expect(tag).toContain('@max-[400px]:hidden');
  });

  // CVP-367 (C49): below the width its tabs need (288 px without counts) the bar gives way instead
  // of running under the pane: it may not be wider than the row, its two long labels end in "…",
  // and All, the shortest, stays whole.
  it('lets the tabs bar shrink to the list, ending the long labels in …, with All kept whole', async () => {
    const html = await view();
    const bar = html.match(/<div[^>]*data-slot="tabs-list"[^>]*>/)?.[0] ?? '';
    expect(bar).toContain('max-w-full');
    const root = html.match(/<div[^>]*data-slot="tabs"[^>]*>/)?.[0] ?? '';
    expect(root).toContain('min-w-0');
    const triggers = [...html.matchAll(/<button[^>]*data-slot="tabs-trigger"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(triggers).toHaveLength(3);
    for (const tag of triggers) expect(tag).toContain('min-w-0');
    const classesOf = (tag: string | undefined) =>
      (tag ?? '').match(/class="([^"]*)"/)?.[1]?.split(/\s+/);
    expect(classesOf(triggers[0])).toContain('shrink-0');
    expect(classesOf(triggers[1])).not.toContain('shrink-0');
    expect(classesOf(triggers[2])).not.toContain('shrink-0');
    const labels = [...html.matchAll(/<span class="truncate">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(['All', 'Hebrew + English', 'English only']);
  });

  it('gives the skeleton rows the same tiers as the real ones, bar by bar', async () => {
    const html = await view({ families: undefined, skeletonDelayMs: 0 });
    for (const tier of ['@max-[590px]:hidden', '@max-[480px]:hidden', '@max-[400px]:hidden']) {
      expect(html.split(tier).length - 1, tier).toBe(10);
    }
    // The script bar is the last to go.
    expect(html.split('@max-[288px]:hidden').length - 1).toBe(10);
    expect(html).toContain('@max-[288px]:grid-cols-[16px_minmax(0,1fr)]');
    const without = await view({ families: undefined, skeletonDelayMs: 0, inNotes: false });
    expect(without.split('@max-[590px]:hidden').length - 1).toBe(0);
    expect(without.split('@max-[480px]:hidden').length - 1).toBe(10);
  });

  it('never hides a row’s name, however narrow the list gets', async () => {
    const html = await view();
    const nameTags = [...html.matchAll(/<button[^>]*data-slot="font-name"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(nameTags).toHaveLength(40);
    for (const tag of nameTags) expect(tag).not.toContain('@max-');
  });
});
