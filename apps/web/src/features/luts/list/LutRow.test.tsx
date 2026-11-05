import type { LutSummary } from '@studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBuiltInLutSummary, makeLutSummary } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import type { LutActions } from './lut-actions';

// Radix draws a right-click menu in a portal that exists only once it is opened, which a server
// render never does. Swap the menu's pieces for plain elements that keep what these tests read: the
// items' words, their state, and the `onSelect` each one runs.
interface DrawnItem {
  label: string;
  disabled: boolean;
  variant: string | undefined;
  title: string | undefined;
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
    ContextMenuItem: ({ children, disabled, variant, title, onSelect }: Props) => {
      drawn.push({
        label: String(children),
        disabled: disabled === true,
        variant: variant as string | undefined,
        title: title as string | undefined,
        select: onSelect as () => void,
      });
      return h(
        'div',
        { role: 'menuitem', 'data-variant': variant, 'data-disabled': disabled ? '' : undefined },
        children,
      );
    },
  };
});

const { LutRow } = await import('./LutRow');

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const yours = makeLutSummary({ addedAt: '2026-10-22T10:00:00.000Z' });
const fresh = makeLutSummary({
  slug: 'soft-pastel',
  name: 'Soft Pastel',
  used: 0,
  usedLabel: 'Not used yet',
  addedAt: minutesAgo(5),
  // The server said true when it answered; the row works it out again.
  isNew: true,
});
const stale = makeLutSummary({
  slug: 'old-one',
  name: 'Old one',
  addedAt: minutesAgo(45),
  isNew: true,
});
const builtIn = makeBuiltInLutSummary();
const camera = makeLutSummary({
  slug: 'sony-s-log3',
  name: 'Sony S-Log3',
  kind: 'camera',
  size: 65,
});
const fix = makeBuiltInLutSummary({ slug: 'red-skin-fix', name: 'Red skin fix', kind: 'fix' });
const cinematic = makeBuiltInLutSummary({ slug: 'cinematic', name: 'Cinematic' });
const hebrew = makeLutSummary({ slug: 'lut-3fa9c1', name: 'סרט ישן' });

function fakeActions(): LutActions {
  return {
    rename: vi.fn().mockResolvedValue('new-slug'),
    duplicate: vi.fn().mockResolvedValue(undefined),
    reveal: vi.fn().mockResolvedValue(undefined),
    copyToken: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
  };
}

async function row(
  lut: LutSummary,
  props: {
    selected?: boolean;
    lutsInEdits?: boolean;
    actions?: LutActions;
    onAskDelete?: (lut: LutSummary) => void;
  } = {},
) {
  const actions = props.actions ?? fakeActions();
  const onAskDelete = props.onAskDelete ?? vi.fn();
  const onSelect = vi.fn();
  const html = await renderAt(
    '/luts',
    <ul>
      <LutRow
        lut={lut}
        selected={props.selected ?? false}
        now={NOW}
        lutsInEdits={props.lutsInEdits ?? true}
        actions={actions}
        onSelect={onSelect}
        onAskDelete={onAskDelete}
        onRenamed={vi.fn()}
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

describe('<LutRow> text', () => {
  it('draws a LUT of Yours: icon, name, "Look · 33³", the used label and when it was added', async () => {
    const { html } = await row(yours);
    expect(html).toContain('data-lut-slug="golden-hour-warm"');
    expect(html).toContain('data-owner="yours"');
    expect(html).toContain('aria-label="Look"');
    expect(html).toContain('lucide-contrast');
    expect(html).toMatch(/data-slot="lut-name"[^>]*>Golden Hour Warm</);
    const text = textOf(html);
    expect(text).toContain('Look · 33³');
    expect(text).toContain('3 jobs');
    expect(text).toContain('2 days ago');
    expect(html).toContain('h-11');
    expect(html).not.toContain('<img');
  });

  it('draws the icon of each kind', async () => {
    expect((await row(camera)).html).toContain('lucide-camera');
    expect((await row(camera)).html).toContain('aria-label="Camera"');
    expect((await row(fix)).html).toContain('lucide-wrench');
    expect((await row(fix)).html).toContain('aria-label="Fix"');
    expect(textOf((await row(camera)).html)).toContain('Camera · 65³');
  });

  it('says "Built in" for a built-in LUT and the cinematic look’s use', async () => {
    const { html } = await row(builtIn);
    const text = textOf(html);
    expect(html).toContain('data-owner="builtIn"');
    expect(text).toContain('Used by the cinematic look');
    expect(text).toContain('Built in');
  });

  it('lets a Hebrew name pick its own reading direction', async () => {
    const { html } = await row(hebrew);
    expect(html).toMatch(/<button[^>]*dir="auto"[^>]*>סרט ישן</);
  });

  it('marks the open row for the eye and for screen readers', async () => {
    const open = (await row(yours, { selected: true })).html;
    expect(open).toContain('data-selected="true"');
    expect(open).toContain('aria-current="true"');
    const closed = (await row(yours)).html;
    expect(closed).toContain('data-selected="false"');
    expect(closed).not.toContain('aria-current');
  });

  it('has the hover and selected backgrounds the same, with a 150 ms ease-in-out', async () => {
    const { html } = await row(yours);
    expect(html).toContain('hover:bg-muted/60');
    expect(html).toContain('data-[selected=true]:bg-muted/60');
    expect(html).toContain('duration-150');
    expect(html).toContain('ease-in-out');
  });
});

describe('<LutRow> New tag', () => {
  it('shows "New" for a LUT added in the last 30 minutes', async () => {
    const { html } = await row(fresh);
    expect(html).toContain('data-slot="lut-new"');
    expect(textOf(html)).toContain('New');
    expect(textOf(html)).toContain('5 min ago');
  });

  it('works the tag out from the added time, not from the server’s word', async () => {
    expect((await row(stale)).html).not.toContain('data-slot="lut-new"');
    expect((await row(yours)).html).not.toContain('data-slot="lut-new"');
    expect((await row(builtIn)).html).not.toContain('data-slot="lut-new"');
  });
});

describe('<LutRow> right-click menu', () => {
  it('has the Yours items in order, with Delete… red', async () => {
    await row(yours);
    expect(drawn.map((entry) => entry.label)).toEqual([
      'Rename',
      'Show in Finder',
      'Duplicate',
      'Copy @luts/golden-hour-warm',
      'Delete…',
    ]);
    expect(item('Delete…')?.variant).toBe('destructive');
    expect(item('Rename')?.variant).toBe('default');
  });

  it('has the Built in items, and no Rename or Delete…', async () => {
    await row(builtIn);
    expect(drawn.map((entry) => entry.label)).toEqual([
      'Show in Finder',
      'Duplicate to Yours',
      'Copy @luts/film-contrast',
    ]);
  });

  it('hides Copy @luts/name while notes cannot name a LUT', async () => {
    await row(yours, { lutsInEdits: false });
    expect(drawn.map((entry) => entry.label)).toEqual([
      'Rename',
      'Show in Finder',
      'Duplicate',
      'Delete…',
    ]);
    drawn.length = 0;
    await row(builtIn, { lutsInEdits: false });
    expect(drawn.map((entry) => entry.label)).toEqual(['Show in Finder', 'Duplicate to Yours']);
  });

  it('names the menu after the LUT', async () => {
    const { html } = await row(yours);
    expect(html).toContain('aria-label="Actions for Golden Hour Warm"');
    expect(html).toContain('role="separator"');
  });

  it('runs each item’s action', async () => {
    const { actions, onAskDelete } = await row(yours);
    item('Show in Finder')?.select();
    expect(actions.reveal).toHaveBeenCalledWith('golden-hour-warm');
    item('Duplicate')?.select();
    expect(actions.duplicate).toHaveBeenCalledWith('golden-hour-warm');
    item('Copy @luts/golden-hour-warm')?.select();
    expect(actions.copyToken).toHaveBeenCalledWith('golden-hour-warm');
    item('Delete…')?.select();
    expect(onAskDelete).toHaveBeenCalledWith(yours);
  });

  it('Duplicate to Yours duplicates a built-in LUT', async () => {
    const { actions } = await row(builtIn);
    item('Duplicate to Yours')?.select();
    expect(actions.duplicate).toHaveBeenCalledWith('film-contrast');
  });

  it('disables Show in Finder for the Cinematic look, with the reason as its title', async () => {
    const { actions } = await row(cinematic);
    expect(item('Show in Finder')?.disabled).toBe(true);
    expect(item('Show in Finder')?.title).toContain('no file');
    expect(actions.reveal).not.toHaveBeenCalled();
  });
});
