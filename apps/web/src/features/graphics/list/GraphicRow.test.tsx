import type { GraphicSummary } from '@studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeGraphicSummary } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import type { GraphicActions } from './graphic-actions';

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

const { GraphicRow } = await import('./GraphicRow');

const ready = makeGraphicSummary({ id: '000000000001', name: 'Name on a white pill' });
const making = makeGraphicSummary({
  id: '000000000002',
  name: 'Hours saved counter',
  kind: 'callout',
  lengthSec: null,
  version: null,
  status: 'making',
  makingVersion: 1,
});
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

function fakeActions(): GraphicActions {
  return {
    open: vi.fn(),
    rename: vi.fn().mockResolvedValue(true),
    duplicate: vi.fn().mockResolvedValue(undefined),
    reveal: vi.fn().mockResolvedValue(undefined),
    setUses: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
  };
}

async function row(
  graphic: GraphicSummary,
  actions = fakeActions(),
  props: { retrying?: boolean; onAskDelete?: (g: GraphicSummary) => void } = {},
) {
  const onRetry = vi.fn();
  const onAskDelete = props.onAskDelete ?? vi.fn();
  const html = await renderAt(
    '/graphics',
    <ul>
      <GraphicRow
        graphic={graphic}
        actions={actions}
        onAskDelete={onAskDelete}
        retrying={props.retrying}
        onRetry={onRetry}
      />
    </ul>,
  );
  return { html, actions, onRetry, onAskDelete };
}

/** The visible text of some markup, tags removed. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

beforeEach(() => {
  drawn.length = 0;
});

describe('<GraphicRow> in every state', () => {
  it('draws a ready graphic: its kind icon, name, "Lower third · 3 s" and the time, no button', async () => {
    const { html } = await row(ready);
    expect(html).toContain('data-status="ready"');
    expect(html).toContain('aria-label="Lower third"');
    expect(html).toContain('lucide-panel-bottom');
    expect(html).toMatch(/data-slot="graphic-name"[^>]*>Name on a white pill</);
    expect(textOf(html)).toContain('Lower third · 3 s');
    expect(html).toContain('<time');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('animate-spin');
  });

  it('draws the icon of each kind', async () => {
    const kinds = [
      ['title', 'lucide-type', 'Title'],
      ['lower-third', 'lucide-panel-bottom', 'Lower third'],
      ['callout', 'lucide-hash', 'Callout'],
      ['end-card', 'lucide-flag', 'End card'],
      ['other', 'lucide-shapes', 'Graphic'],
    ] as const;
    for (const [kind, icon, label] of kinds) {
      const { html } = await row({ ...ready, kind });
      expect(html, kind).toContain(icon);
      expect(html, kind).toContain(`aria-label="${label}"`);
    }
  });

  it('draws a graphic that is being made: a blue spinner, "Making v1…" in blue, no button', async () => {
    const { html } = await row(making);
    expect(html).toContain('data-status="making"');
    expect(html).toContain('aria-label="Being made"');
    expect(html).toContain('animate-spin');
    expect(html).toMatch(/text-blue-300[^>]*>Making v1…</);
    expect(html).not.toContain('Retry');
  });

  it('draws a failed graphic: the red mark, "Couldn’t finish v3" in red and the ghost Retry v3 button', async () => {
    const { html } = await row(failed);
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('aria-label="A version failed"');
    expect(html).toContain('text-status-failed');
    expect(html).toMatch(/text-red-300[^>]*>Couldn’t finish v3</);
    expect(html).toContain('aria-label="Retry v3"');
    expect(html).toContain('data-variant="ghost"');
  });

  it('waits on Retry while it is being sent', async () => {
    expect((await row(failed)).html).toMatch(/aria-label="Retry v3"/);
    expect((await row(failed)).html).not.toMatch(/aria-label="Retry v3"[^>]*disabled/);
    expect((await row(failed, fakeActions(), { retrying: true })).html).toMatch(
      /<button[^>]*aria-label="Retry v3"[^>]*disabled=""/,
    );
  });

  it('says "off for edits" in a quieter shade for a graphic edits do not use', async () => {
    const { html } = await row(off);
    expect(html).toContain('data-uses="off"');
    expect(html).toMatch(/text-zinc-500[^>]*>Lower third · 3 s · off for edits</);
  });

  it('gives a Hebrew name its own direction', async () => {
    const { html } = await row(hebrew);
    expect(html).toMatch(/<button[^>]*dir="auto"[^>]*>מיתוס או אמת – פתיחה</);
    expect(textOf(html)).toContain('Title · 2.4 s');
  });

  it('has no badge, no border and no still: a quiet row of 44 px', async () => {
    const { html } = await row(ready);
    expect(html).toContain('h-11');
    expect(html).not.toContain('data-slot="badge"');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<li[^>]*class="[^"]*\bborder\b/);
  });

  it('is one target: the name button covers the row, and the next-step cell sits above it', async () => {
    const { html } = await row(failed);
    expect(html).toContain('after:absolute after:inset-0');
    expect(html).toMatch(/relative z-10 flex justify-end/);
  });
});

describe('<GraphicRow>’s right-click menu', () => {
  it('has the items in the board’s order, labelled for the menu', async () => {
    await row(ready);
    expect(drawn.map((item) => item.label)).toEqual([
      'Open',
      'Rename',
      'Duplicate',
      'Show in Finder',
      'Turn off for edits',
      'Delete…',
    ]);
  });

  it('is named for the graphic and has its two lines', async () => {
    const { html } = await row(ready);
    expect(html).toContain('aria-label="Actions for Name on a white pill"');
    expect(html.match(/role="separator"/g)).toHaveLength(2);
  });

  it('shows Turn on for a graphic edits do not use', async () => {
    await row(off);
    expect(drawn.map((item) => item.label)).toContain('Turn on for edits');
    expect(drawn.map((item) => item.label)).not.toContain('Turn off for edits');
  });

  it('draws Delete… as the destructive item, and no other', async () => {
    await row(ready);
    expect(drawn.filter((item) => item.variant === 'destructive').map((i) => i.label)).toEqual([
      'Delete…',
    ]);
  });

  it('runs Open', async () => {
    const { actions } = await row(ready);
    find('Open').select();
    expect(actions.open).toHaveBeenCalledExactlyOnceWith(ready.id);
  });

  it('runs Duplicate and Show in Finder on that graphic', async () => {
    const { actions } = await row(ready);
    find('Duplicate').select();
    find('Show in Finder').select();
    expect(actions.duplicate).toHaveBeenCalledExactlyOnceWith(ready.id);
    expect(actions.reveal).toHaveBeenCalledExactlyOnceWith(ready.id);
  });

  it('turns edits off for a graphic they use, and on for one they do not', async () => {
    const used = await row(ready);
    find('Turn off for edits').select();
    expect(used.actions.setUses).toHaveBeenCalledExactlyOnceWith(ready.id, false);

    drawn.length = 0;
    const unused = await row(off);
    find('Turn on for edits').select();
    expect(unused.actions.setUses).toHaveBeenCalledExactlyOnceWith(off.id, true);
  });

  it('asks the list to ask "Delete “Name”?" and deletes nothing itself', async () => {
    const { actions, onAskDelete } = await row(ready);
    find('Delete…').select();
    expect(onAskDelete).toHaveBeenCalledExactlyOnceWith(ready);
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it('keeps Rename for the row’s own field: it runs no request until a name is typed', async () => {
    const { actions } = await row(ready);
    find('Rename').select();
    expect(actions.rename).not.toHaveBeenCalled();
  });

  it('disables Rename while a version is being made and says why, as a tooltip', async () => {
    await row(making);
    const rename = find('Rename');
    expect(rename.disabled).toBe(true);
    expect(rename.title).toBe('Wait until v1 is made, then rename it.');
  });

  it('disables Duplicate until v1 is made and says why', async () => {
    await row(making);
    const duplicate = find('Duplicate');
    expect(duplicate.disabled).toBe(true);
    expect(duplicate.title).toBe('There is nothing to copy until v1 is made.');
  });

  it('leaves every item enabled for a failed graphic', async () => {
    await row(failed);
    expect(drawn.filter((item) => item.disabled)).toEqual([]);
  });
});

function find(label: string): DrawnItem {
  const item = drawn.find((candidate) => candidate.label === label);
  if (item === undefined) throw new Error(`no menu item "${label}"`);
  return item;
}
