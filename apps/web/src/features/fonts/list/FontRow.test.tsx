import type { FontFamilySummary } from '@studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFontFamilySummary } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import type { FontActions } from './font-actions';

// Radix draws a right-click menu in a portal that exists only once it is opened, which a server
// render never does. Swap the menu's pieces for plain elements that keep what these tests read: the
// items' words, their state, and the `onSelect` each one runs.
interface DrawnItem {
  label: string;
  variant: string | undefined;
  select: () => void;
}
const drawn: DrawnItem[] = [];

vi.mock('@/components/ui/context-menu', async (importOriginal) => {
  const { createElement: h, Children } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    ...(await importOriginal<typeof import('@/components/ui/context-menu')>()),
    ContextMenu: ({ children }: Props) => h('div', { 'data-menu-root': '' }, children),
    // asChild: the trigger is its only child, unchanged.
    ContextMenuTrigger: ({ children }: Props) => Children.only(children),
    ContextMenuContent: ({ children, 'aria-label': label }: Props) =>
      h('div', { role: 'menu', 'aria-label': label as string }, children),
    ContextMenuSeparator: () => h('hr', { role: 'separator' }),
    ContextMenuItem: ({ children, variant, onSelect }: Props) => {
      drawn.push({
        label: String(children),
        variant: variant as string | undefined,
        select: onSelect as () => void,
      });
      return h('div', { role: 'menuitem', 'data-variant': variant }, children);
    },
  };
});

const { FontRow } = await import('./FontRow');

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const heebo = makeFontFamilySummary();
const fresh = makeFontFamilySummary({
  slug: 'karantina',
  name: 'Karantina',
  weights: [300, 400, 700],
  weightsLabel: '3 weights',
  used: 0,
  usedLabel: 'Not used yet',
  addedAt: minutesAgo(5),
  isNew: true,
});
const stale = makeFontFamilySummary({
  slug: 'old-one',
  name: 'Old one',
  addedAt: minutesAgo(45),
  isNew: true,
});
const english = makeFontFamilySummary({
  slug: 'poppins',
  name: 'Poppins',
  he: false,
  used: 1,
  usedLabel: '1 job',
});
const hebrewName = makeFontFamilySummary({ slug: 'font-3fa9c1', name: 'דוד' });

function fakeActions(): FontActions {
  return {
    reveal: vi.fn().mockResolvedValue(undefined),
    copyToken: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
  };
}

async function row(
  family: FontFamilySummary,
  props: {
    selected?: boolean;
    actions?: FontActions;
    inNotes?: boolean;
    onAskDelete?: (family: FontFamilySummary) => void;
  } = {},
) {
  const actions = props.actions ?? fakeActions();
  const onAskDelete = props.onAskDelete ?? vi.fn();
  const onSelect = vi.fn();
  const html = await renderAt(
    '/fonts',
    <ul>
      <FontRow
        family={family}
        selected={props.selected ?? false}
        now={NOW}
        actions={actions}
        inNotes={props.inNotes ?? true}
        onSelect={onSelect}
        onAskDelete={onAskDelete}
      />
    </ul>,
  );
  return { html, actions, onAskDelete, onSelect };
}

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const item = (label: string) => drawn.find((entry) => entry.label === label);

beforeEach(() => {
  drawn.length = 0;
});

describe('<FontRow> text', () => {
  it('draws a family: icon, name, script, "9 weights", the used label and when it was added', async () => {
    const { html } = await row(heebo);
    expect(html).toContain('data-font-slug="heebo"');
    expect(html).toContain('lucide-case-sensitive');
    expect(html).toMatch(/data-slot="font-name"[^>]*>Heebo</);
    const text = textOf(html);
    expect(text).toContain('Heebo Hebrew + English 9 weights 14 jobs 2 days ago');
    expect(html).toContain('h-11');
    expect(html).toContain('grid-cols-[16px_minmax(0,1fr)_124px_84px_96px_84px]');
    expect(html).not.toContain('<img');
  });

  it('says English only for a family without Hebrew, and shows the used label as the server gave it', async () => {
    const text = textOf((await row(english)).html);
    expect(text).toContain('English only');
    expect(text).toContain('1 job');
    expect(textOf((await row(fresh)).html)).toContain('Not used yet');
  });

  it('gives the exact added time as a tooltip', async () => {
    const { html } = await row(heebo);
    expect(html).toMatch(/title="Thu 22 Oct 2026, \d\d:07"/);
  });

  it('lets a Hebrew name pick its own reading direction', async () => {
    const { html } = await row(hebrewName);
    expect(html).toMatch(/<button[^>]*dir="auto"[^>]*>דוד</);
  });

  it('marks the open row for the eye and for screen readers', async () => {
    const open = (await row(heebo, { selected: true })).html;
    expect(open).toContain('data-selected="true"');
    expect(open).toContain('aria-current="true"');
    const closed = (await row(heebo)).html;
    expect(closed).toContain('data-selected="false"');
    expect(closed).not.toContain('aria-current');
  });

  it('has the hover and selected backgrounds the same, with a 150 ms ease-in-out', async () => {
    const { html } = await row(heebo);
    expect(html).toContain('hover:bg-muted/60');
    expect(html).toContain('data-[selected=true]:bg-muted/60');
    expect(html).toContain('duration-150');
    expect(html).toContain('ease-in-out');
  });

  it('makes the whole row the click target through the name button', async () => {
    const { html } = await row(heebo);
    expect(html).toContain('after:absolute after:inset-0');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*data-slot="font-name"/);
  });
});

describe('<FontRow> New tag', () => {
  it('shows "New" for a family added in the last 30 minutes, and "5 min ago"', async () => {
    const { html } = await row(fresh);
    expect(html).toContain('data-slot="font-new"');
    expect(textOf(html)).toContain('New');
    expect(textOf(html)).toContain('5 min ago');
  });

  it('works the end of the tag out from the added time, not from the server’s word', async () => {
    expect((await row(stale)).html).not.toContain('data-slot="font-new"');
    expect((await row(heebo)).html).not.toContain('data-slot="font-new"');
  });

  it('says "Just now" for a family added a moment ago', async () => {
    const justNow = makeFontFamilySummary({ addedAt: minutesAgo(0), isNew: true });
    expect(textOf((await row(justNow)).html)).toContain('Just now');
  });
});

describe('<FontRow> while notes cannot name a font yet', () => {
  it('has no used column: the grid is the icon, name, script, weights and added', async () => {
    const { html } = await row(heebo, { inNotes: false });
    expect(html).toContain('grid-cols-[16px_minmax(0,1fr)_124px_84px_84px]');
    expect(html).not.toContain('data-slot="font-used"');
    const text = textOf(html);
    expect(text).toContain('Heebo Hebrew + English 9 weights 2 days ago');
    expect(text).not.toContain('14 jobs');
    expect(text).not.toContain('Not used yet');
  });

  it('keeps the used column once notes can name a font', async () => {
    const { html } = await row(heebo, { inNotes: true });
    expect(html).toContain('data-slot="font-used"');
  });

  it('has no Copy @name in the right-click menu', async () => {
    await row(heebo, { inNotes: false });
    expect(drawn.map((entry) => entry.label)).toEqual(['Show in Finder', 'Delete…']);
  });
});

describe('<FontRow> right-click menu', () => {
  it('has Show in Finder, Copy @name and Delete… in order, with Delete… red', async () => {
    await row(heebo);
    expect(drawn.map((entry) => entry.label)).toEqual(['Show in Finder', 'Copy @Heebo', 'Delete…']);
    expect(item('Delete…')?.variant).toBe('destructive');
    expect(item('Show in Finder')?.variant).toBe('default');
  });

  it('puts a line before Delete… and names the menu after the family', async () => {
    const { html } = await row(heebo);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Actions for Heebo"');
    expect(html.indexOf('Copy @Heebo')).toBeLessThan(html.indexOf('role="separator"'));
    expect(html.indexOf('role="separator"')).toBeLessThan(html.indexOf('>Delete…<'));
  });

  it('has no Rename: a font’s name comes from its file', async () => {
    await row(heebo);
    expect(drawn.some((entry) => /rename/i.test(entry.label))).toBe(false);
  });

  it('runs each item’s action', async () => {
    const { actions, onAskDelete } = await row(heebo);
    item('Show in Finder')?.select();
    expect(actions.reveal).toHaveBeenCalledWith('heebo');
    item('Copy @Heebo')?.select();
    expect(actions.copyToken).toHaveBeenCalledWith('Heebo');
    item('Delete…')?.select();
    expect(onAskDelete).toHaveBeenCalledWith(heebo);
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it('copies the name with its spaces', async () => {
    const family = makeFontFamilySummary({ slug: 'amatic-sc', name: 'Amatic SC' });
    const { actions } = await row(family);
    item('Copy @Amatic SC')?.select();
    expect(actions.copyToken).toHaveBeenCalledWith('Amatic SC');
  });
});

// CVP-366 (C48): the open pane takes 440 px, so the list is 296 px wide in a 1024 px window and the
// five fixed columns left the name 0 px. A row drops its columns by the LIST's width (a container
// query on the list's root, which no test runs), so these read the classes the row carries and
// work out, as the browser does, which grid and which cells a given list width gets.
describe('<FontRow> in a narrow list', () => {
  const PADDING = 24; // px-3 on each side
  const GAP = 12; // gap-3
  const MIN_NAME = 100;

  /** The classes of the row's `<li>`. */
  const rowClasses = (html: string) =>
    (html.match(/<li[^>]*class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

  /** The opening tag of the cell that has this `data-slot`. */
  const cellTag = (html: string, slot: string) =>
    html.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`))?.[0] ?? '';

  /** The list width under which the cell is hidden (the `@max-` hidden class of its cell), or null if it never is. */
  const hiddenUnder = (tag: string) => {
    const found = tag.match(/@max-\[(\d+)px\]:hidden/);
    return found === null ? null : Number(found[1]);
  };

  /** The tracks of the grid a list of this width gives the row, as the cascade picks them. */
  function tracksAt(html: string, width: number): string[] {
    const classes = rowClasses(html);
    const base = classes.find((name) => name.startsWith('grid-cols-['));
    const narrower = classes
      .map((name) => name.match(/^@max-\[(\d+)px\]:grid-cols-\[(.+)\]$/))
      .filter((found): found is RegExpMatchArray => found !== null)
      .map((found) => ({ under: Number(found[1]), cols: found[2] ?? '' }))
      // The query that holds with the smallest limit wins: a smaller limit comes later in the CSS.
      .filter((query) => width < query.under)
      .sort((a, b) => a.under - b.under)[0];
    return (narrower?.cols ?? base?.slice('grid-cols-['.length, -1) ?? '').split('_');
  }

  /** How many cells are showing at this list width: the icon, the name, and the columns that stay. */
  function cellsAt(html: string, width: number): number {
    const slots = ['font-script', 'font-weights-label', 'font-used', 'font-added'];
    const showing = slots.filter((slot) => {
      const tag = cellTag(html, slot);
      if (tag === '') return false;
      const limit = hiddenUnder(tag);
      return limit === null || width >= limit;
    });
    return 2 + showing.length;
  }

  function nameWidthAt(html: string, width: number): number {
    const tracks = tracksAt(html, width);
    const fixed = tracks
      .filter((track) => track.endsWith('px'))
      .reduce((sum, track) => sum + Number.parseInt(track, 10), 0);
    return width - PADDING - GAP * (tracks.length - 1) - fixed;
  }

  it.each([
    ['a row with the used column', true],
    ['a row without it', false],
  ])(
    '%s has a track for every cell that shows, and a name never under 100 px',
    async (_label, inNotes) => {
      const { html } = await row(heebo, { inNotes });
      // From the narrowest list a name and an icon fit in (152 px) to far wider than any window.
      for (let width = 152; width <= 1200; width += 1) {
        expect(tracksAt(html, width), `tracks at ${width}`).toHaveLength(cellsAt(html, width));
        expect(nameWidthAt(html, width), `name at ${width}`).toBeGreaterThanOrEqual(MIN_NAME);
      }
    },
  );

  it('keeps every column of the board in a list 552 px wide (a 1280 px window) when notes cannot name a font', async () => {
    const { html } = await row(heebo, { inNotes: false });
    expect(tracksAt(html, 552)).toEqual(['16px', 'minmax(0,1fr)', '124px', '84px', '84px']);
    expect(cellsAt(html, 552)).toBe(5);
    expect(tracksAt(html, 712)).toEqual(['16px', 'minmax(0,1fr)', '124px', '84px', '84px']);
  });

  it('keeps the used column only in a list wide enough for it: 712 px yes, 552 px no', async () => {
    const { html } = await row(heebo, { inNotes: true });
    expect(tracksAt(html, 712)).toEqual(['16px', 'minmax(0,1fr)', '124px', '84px', '96px', '84px']);
    expect(cellsAt(html, 712)).toBe(6);
    expect(tracksAt(html, 552)).toEqual(['16px', 'minmax(0,1fr)', '124px', '84px', '84px']);
    expect(cellsAt(html, 552)).toBe(5);
  });

  it('shows the icon, the name and the script in a list 296 px wide (a 1024 px window)', async () => {
    for (const inNotes of [true, false]) {
      const { html } = await row(heebo, { inNotes });
      expect(tracksAt(html, 296)).toEqual(['16px', 'minmax(0,1fr)', '124px']);
      expect(cellsAt(html, 296)).toBe(3);
      expect(nameWidthAt(html, 296)).toBeGreaterThanOrEqual(108);
    }
  });

  it('drops the script last, and leaves the icon and the name whatever the width', async () => {
    const { html } = await row(heebo);
    expect(tracksAt(html, 200)).toEqual(['16px', 'minmax(0,1fr)']);
    expect(cellsAt(html, 200)).toBe(2);
    // The name is never one of the cells that leaves, and it can still shrink and show "…".
    const name = cellTag(html, 'font-name');
    expect(name).not.toContain('@max-');
    expect(name).toContain('min-w-0');
    expect(name).toContain('truncate');
    expect(html).toContain('lucide-case-sensitive');
  });

  it('draws the used column with its own limit, and the others with theirs', async () => {
    const { html } = await row(heebo);
    expect(hiddenUnder(cellTag(html, 'font-used'))).toBe(590);
    expect(hiddenUnder(cellTag(html, 'font-added'))).toBe(480);
    expect(hiddenUnder(cellTag(html, 'font-weights-label'))).toBe(400);
    expect(hiddenUnder(cellTag(html, 'font-script'))).toBe(288);
  });
});
