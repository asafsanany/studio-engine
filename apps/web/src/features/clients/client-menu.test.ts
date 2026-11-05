import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '@/router';
import {
  clientMenuActions,
  clientMenuEntries,
  clientPageLocation,
  clientPageMenuEntries,
  clientStyleLocation,
} from './client-menu';

describe('clientMenuEntries', () => {
  const entries = () =>
    clientMenuEntries({
      open: () => undefined,
      viewStyle: () => undefined,
      reveal: () => undefined,
    });

  it('is Open, View style, a line, then Show in Finder', () => {
    expect(entries().map((entry) => (entry.type === 'separator' ? '---' : entry.label))).toEqual([
      'Open',
      'View style',
      '---',
      'Show in Finder',
    ]);
  });

  it('gives each item an icon and leaves all enabled and plain (not red)', () => {
    for (const entry of entries()) {
      if (entry.type !== 'item') continue;
      expect(entry.icon).toBeDefined();
      expect(entry.disabled).toBeUndefined();
      expect(entry.destructive).toBeUndefined();
      expect(entry.href).toBeUndefined();
    }
  });

  it('runs the matching action when an item is chosen', () => {
    const open = vi.fn();
    const viewStyle = vi.fn();
    const reveal = vi.fn();
    const [openItem, styleItem, , revealItem] = clientMenuEntries({ open, viewStyle, reveal });

    if (openItem?.type !== 'item' || styleItem?.type !== 'item' || revealItem?.type !== 'item') {
      throw new Error('not items');
    }
    openItem.onSelect();
    expect(open).toHaveBeenCalledOnce();
    expect(viewStyle).not.toHaveBeenCalled();
    styleItem.onSelect();
    expect(viewStyle).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
    revealItem.onSelect();
    expect(reveal).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(viewStyle).toHaveBeenCalledOnce();
  });
});

describe('clientMenuActions', () => {
  const setup = () => {
    const navigate = vi.fn();
    const reveal = vi.fn();
    const [openItem, styleItem, , revealItem] = clientMenuEntries(
      clientMenuActions('4d337086919d', { navigate, reveal }),
    );
    if (openItem?.type !== 'item' || styleItem?.type !== 'item' || revealItem?.type !== 'item') {
      throw new Error('not items');
    }
    return { navigate, reveal, openItem, styleItem, revealItem };
  };

  it('opens the client page with Open', () => {
    const { navigate, openItem } = setup();
    openItem.onSelect();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/clients/$clientId',
      params: { clientId: '4d337086919d' },
    });
  });

  it('opens the Style page with View style', () => {
    const { navigate, styleItem } = setup();
    styleItem.onSelect();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/clients/$clientId/style',
      params: { clientId: '4d337086919d' },
    });
  });

  it('reveals the client folder with Show in Finder, and goes nowhere', () => {
    const { navigate, reveal, revealItem } = setup();
    revealItem.onSelect();
    expect(reveal).toHaveBeenCalledExactlyOnceWith('4d337086919d');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('goes to the addresses the app has: /clients/<id> and /clients/<id>/style', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/clients'] }));
    await router.load();

    expect(router.buildLocation(clientStyleLocation('4d337086919d')).pathname).toBe(
      '/clients/4d337086919d/style',
    );
    expect(router.buildLocation(clientPageLocation('4d337086919d')).pathname).toBe(
      '/clients/4d337086919d',
    );
  });
});

describe('Assign to… (Team plan, TM5)', () => {
  const labels = (assign: (() => void) | undefined, admin = true) =>
    clientMenuEntries(
      { open: () => undefined, viewStyle: () => undefined, reveal: () => undefined, assign },
      admin,
    ).map((entry) => (entry.type === 'separator' ? '---' : entry.label));

  it('is the admin’s item after View style, before the line and Show in Finder', () => {
    expect(labels(() => undefined)).toEqual([
      'Open',
      'View style',
      'Assign to…',
      '---',
      'Show in Finder',
    ]);
  });

  it('is left out when the actions have no assign, and for an editor whatever they have', () => {
    expect(labels(undefined)).toEqual(['Open', 'View style', '---', 'Show in Finder']);
    expect(labels(() => undefined, false)).toEqual(['Open', 'View style']);
  });

  it('asks for the client’s own dialog when chosen', () => {
    const assign = vi.fn();
    const entries = clientMenuEntries(
      clientMenuActions('4d337086919d', { navigate: vi.fn(), reveal: vi.fn(), assign }),
    );
    const item = entries.find((entry) => entry.type === 'item' && entry.id === 'assign');
    if (item?.type !== 'item') throw new Error('no Assign to… item');
    expect(item.icon).toBeDefined();
    item.onSelect();
    expect(assign).toHaveBeenCalledExactlyOnceWith('4d337086919d');
  });
});

describe('Rename…', () => {
  const noop = () => undefined;
  const labels = (rename: (() => void) | undefined, admin = true) =>
    clientMenuEntries(
      { open: noop, viewStyle: noop, reveal: noop, assign: noop, ...(rename && { rename }) },
      admin,
    ).map((entry) => (entry.type === 'separator' ? '---' : entry.label));

  it('is the admin’s item after Assign to…, before the line and Show in Finder', () => {
    expect(labels(noop)).toEqual([
      'Open',
      'View style',
      'Assign to…',
      'Rename…',
      '---',
      'Show in Finder',
    ]);
  });

  it('is left out when the actions have no rename, and for an editor', () => {
    expect(labels(undefined)).not.toContain('Rename…');
    expect(labels(noop, false)).toEqual(['Open', 'View style']);
  });

  it('asks for the client’s own dialog when chosen', () => {
    const rename = vi.fn();
    const entries = clientMenuEntries(
      clientMenuActions('4d337086919d', { navigate: vi.fn(), reveal: vi.fn(), rename }),
    );
    const item = entries.find((entry) => entry.type === 'item' && entry.id === 'rename');
    if (item?.type !== 'item') throw new Error('no Rename… item');
    item.onSelect();
    expect(rename).toHaveBeenCalledExactlyOnceWith('4d337086919d');
  });
});

describe('Delete…', () => {
  const noop = () => undefined;
  const labels = (remove: (() => void) | undefined, admin = true) =>
    clientMenuEntries(
      { open: noop, viewStyle: noop, reveal: noop, rename: noop, ...(remove && { remove }) },
      admin,
    ).map((entry) => (entry.type === 'separator' ? '---' : entry.label));

  it('is the admin’s last item, in red, after Show in Finder and a line of its own', () => {
    expect(labels(noop)).toEqual([
      'Open',
      'View style',
      'Rename…',
      '---',
      'Show in Finder',
      '---',
      'Delete…',
    ]);
    const item = clientMenuEntries({ open: noop, viewStyle: noop, reveal: noop, remove: noop }).at(
      -1,
    );
    if (item?.type !== 'item') throw new Error('no Delete… item');
    expect(item.destructive).toBe(true);
    expect(item.icon).toBeDefined();
  });

  it('is left out when the actions have no remove, and for an editor', () => {
    expect(labels(undefined)).not.toContain('Delete…');
    expect(labels(noop, false)).toEqual(['Open', 'View style']);
  });

  it('asks for the client’s own dialog when chosen', () => {
    const remove = vi.fn();
    const entries = clientMenuEntries(
      clientMenuActions('4d337086919d', { navigate: vi.fn(), reveal: vi.fn(), remove }),
    );
    const item = entries.find((entry) => entry.type === 'item' && entry.id === 'delete');
    if (item?.type !== 'item') throw new Error('no Delete… item');
    item.onSelect();
    expect(remove).toHaveBeenCalledExactlyOnceWith('4d337086919d');
  });
});

describe('Instagram…', () => {
  const noop = () => undefined;
  const labels = (instagram: (() => void) | undefined, admin = true) =>
    clientMenuEntries(
      {
        open: noop,
        viewStyle: noop,
        reveal: noop,
        assign: noop,
        rename: noop,
        ...(instagram && { instagram }),
      },
      admin,
    ).map((entry) => (entry.type === 'separator' ? '---' : entry.label));

  it('is the item after View style, before Assign to…', () => {
    expect(labels(noop)).toEqual([
      'Open',
      'View style',
      'Instagram…',
      'Assign to…',
      'Rename…',
      '---',
      'Show in Finder',
    ]);
  });

  it('is left out when the actions have none (Clients × Instagram is off)', () => {
    expect(labels(undefined)).not.toContain('Instagram…');
  });

  it('is an editor’s item too: the client’s Instagram is not the admin’s alone', () => {
    expect(labels(noop, false)).toEqual(['Open', 'View style', 'Instagram…']);
  });

  it('has an icon, is plain (not red), and asks for the client’s own dialog when chosen', () => {
    const instagram = vi.fn();
    const entries = clientMenuEntries(
      clientMenuActions('4d337086919d', { navigate: vi.fn(), reveal: vi.fn(), instagram }),
    );
    const item = entries.find((entry) => entry.type === 'item' && entry.id === 'instagram');
    if (item?.type !== 'item') throw new Error('no Instagram… item');
    expect(item.icon).toBeDefined();
    expect(item.destructive).toBeUndefined();
    item.onSelect();
    expect(instagram).toHaveBeenCalledExactlyOnceWith('4d337086919d');
  });
});

describe('clientPageMenuEntries (the ⋯ on the client page, C93)', () => {
  const noop = () => undefined;
  const actions = {
    open: noop,
    viewStyle: noop,
    reveal: noop,
    instagram: noop,
    assign: noop,
    rename: noop,
    remove: noop,
  };
  const labels = (admin?: boolean, given: Parameters<typeof clientPageMenuEntries>[0] = actions) =>
    clientPageMenuEntries(given, admin).map((entry) =>
      entry.type === 'separator' ? '---' : entry.label,
    );

  it('is the row menu without Open and View style, for the admin', () => {
    expect(labels()).toEqual([
      'Instagram…',
      'Assign to…',
      'Rename…',
      '---',
      'Show in Finder',
      '---',
      'Delete…',
    ]);
  });

  it('has no Instagram… while the switch is off, as the list’s menu has none', () => {
    const { instagram: _off, ...withoutInstagram } = actions;
    expect(labels(true, withoutInstagram)).toEqual([
      'Assign to…',
      'Rename…',
      '---',
      'Show in Finder',
      '---',
      'Delete…',
    ]);
  });

  it('is Instagram… alone for an editor, and nothing for an editor with the switch off', () => {
    expect(labels(false)).toEqual(['Instagram…']);
    const { instagram: _off, ...withoutInstagram } = actions;
    expect(labels(false, withoutInstagram)).toEqual([]);
  });

  it('keeps the list’s own items (same ids, icons, red Delete…) and runs their actions', () => {
    const instagram = vi.fn();
    const entries = clientPageMenuEntries({ ...actions, instagram });
    const rowIds = clientMenuEntries(actions).map((entry) => entry.id);
    for (const entry of entries) expect(rowIds).toContain(entry.id);
    const first = entries[0];
    if (first?.type !== 'item') throw new Error('not an item');
    first.onSelect();
    expect(instagram).toHaveBeenCalledOnce();
    const last = entries.at(-1);
    expect(last?.type === 'item' && last.destructive).toBe(true);
  });
});
