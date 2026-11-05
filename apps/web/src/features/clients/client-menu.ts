import { ArrowRight, AtSign, Folder, Pencil, Trash2, UserPlus } from 'lucide-react';
import { FileText } from '@/components/icons';
import type { RowMenuEntry } from '../jobs/row-menu';

export interface ClientMenuActions {
  /** Opens the client's page. */
  open: () => void;
  /** Opens the client's Style page. */
  viewStyle: () => void;
  /** Opens the client's folder in Finder. */
  reveal: () => void;
  /** Opens "Instagram…": the client's Instagram account. Absent (the switch is off): no such item. */
  instagram?: () => void;
  /** Opens "Assign to…" (the admin's): which editors see the client. Absent: the menu has no such item. */
  assign?: () => void;
  /** Opens "Rename client" (the admin's): the folder, exports and videos take the new name. Absent: no such item. */
  rename?: () => void;
  /** Opens "Delete client" (the admin's): its folders go to the Trash, its videos go. Absent: no such item. */
  remove?: () => void;
}

/** Where a client's page is, as the router takes it. */
export function clientPageLocation(clientId: string) {
  return { to: '/clients/$clientId', params: { clientId } } as const;
}

/** Where a client's Style page is, as the router takes it. */
export function clientStyleLocation(clientId: string) {
  return { to: '/clients/$clientId/style', params: { clientId } } as const;
}

/** What a client row's menu does with the router and with Finder; `ClientRow` passes the real ones. */
export interface ClientMenuTools {
  navigate: (location: ReturnType<typeof clientPageLocation | typeof clientStyleLocation>) => void;
  reveal: (clientId: string) => void;
  /** Opens "Instagram…" for the client. Left out, the actions have none. */
  instagram?: (clientId: string) => void;
  /** Opens "Assign to…" for the client. Left out, the actions have none. */
  assign?: (clientId: string) => void;
  /** Opens "Rename client" for the client. Left out, the actions have none. */
  rename?: (clientId: string) => void;
  /** Opens "Delete client" for the client. Left out, the actions have none. */
  remove?: (clientId: string) => void;
}

/** The actions of one client's row: Open and View style go to its pages, Show in Finder reveals it. */
export function clientMenuActions(
  clientId: string,
  { navigate, reveal, instagram, assign, rename, remove }: ClientMenuTools,
): ClientMenuActions {
  return {
    open: () => navigate(clientPageLocation(clientId)),
    viewStyle: () => navigate(clientStyleLocation(clientId)),
    reveal: () => reveal(clientId),
    ...(instagram === undefined ? {} : { instagram: () => instagram(clientId) }),
    ...(assign === undefined ? {} : { assign: () => assign(clientId) }),
    ...(rename === undefined ? {} : { rename: () => rename(clientId) }),
    ...(remove === undefined ? {} : { remove: () => remove(clientId) }),
  };
}

/**
 * Everything in a client row's right-click menu, top to bottom: Open, View style, Instagram…
 * (while Clients × Instagram is on; an editor has it too), Assign to… and Rename… (the admin's,
 * when the actions have them), a line, Show in Finder, and Delete… after a
 * line of its own (in red, the Jobs table's way, when the actions have it). The menu is drawn from
 * this list (the Jobs table's way), so adding an item is adding an entry. Show in Finder opens the
 * Mac's Finder, so it is the admin's: an editor's menu (`admin` false) ends at View style (or
 * Instagram…), with no line after it.
 */
export function clientMenuEntries(
  { open, viewStyle, reveal, instagram, assign, rename, remove }: ClientMenuActions,
  admin = true,
): RowMenuEntry[] {
  const entries: RowMenuEntry[] = [
    { type: 'item', id: 'open', label: 'Open', icon: ArrowRight, onSelect: open },
    { type: 'item', id: 'style', label: 'View style', icon: FileText, onSelect: viewStyle },
  ];
  if (instagram !== undefined) {
    entries.push({
      type: 'item',
      id: 'instagram',
      label: 'Instagram…',
      icon: AtSign,
      onSelect: instagram,
    });
  }
  if (!admin) return entries;
  if (assign !== undefined) {
    entries.push({
      type: 'item',
      id: 'assign',
      label: 'Assign to…',
      icon: UserPlus,
      onSelect: assign,
    });
  }
  if (rename !== undefined) {
    entries.push({
      type: 'item',
      id: 'rename',
      label: 'Rename…',
      icon: Pencil,
      onSelect: rename,
    });
  }
  entries.push(
    { type: 'separator', id: 'folder-separator' },
    { type: 'item', id: 'reveal', label: 'Show in Finder', icon: Folder, onSelect: reveal },
  );
  if (remove !== undefined) {
    entries.push(
      { type: 'separator', id: 'delete-separator' },
      {
        type: 'item',
        id: 'delete',
        label: 'Delete…',
        icon: Trash2,
        destructive: true,
        onSelect: remove,
      },
    );
  }
  return entries;
}

/**
 * The client page's ⋯ menu: the row menu's entries without Open and View style, since the page is
 * the client's own and the Style button sits beside the ⋯. What is left is Instagram… (while the
 * switch is on; an editor has it too) and, for the admin, Assign to…, Rename…, Show in Finder and
 * Delete…. An editor with the switch off has none, and the page shows no ⋯ then.
 */
export function clientPageMenuEntries(actions: ClientMenuActions, admin = true): RowMenuEntry[] {
  return clientMenuEntries(actions, admin).filter(
    (entry) => entry.id !== 'open' && entry.id !== 'style',
  );
}
