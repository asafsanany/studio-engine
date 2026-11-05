import type { ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { TableRow } from '@/components/ui/table';
import { useIsAdmin } from '@/data';
import { MENU_WIDTH, RowMenuItemView } from '../jobs/JobRow';
import { isContextMenuKey, openMenuFromKeyboard } from '../jobs/row-menu-key';
import { clientMenuEntries } from './client-menu';
import type { ClientSummary } from './clients';
import { useClientMenuActions } from './use-client-menu-actions';

/**
 * A table row of the Clients board with its right-click menu (Open, View style, Instagram… while Clients × Instagram is on; Assign to…, Rename…, Show in Finder and Delete… for the admin).
 * The row is the positioned box of the name's link, which stretches over it, so a click anywhere on
 * the row opens the client; Tab reaches the link and Enter follows it. A right-click anywhere on
 * the row opens the menu, and so does Shift+F10 or the keyboard's menu key while focus is inside
 * the row.
 *
 * While its menu is open the row keeps its hover background (the menu is modal, so the pointer is
 * not "over" the row any more). Keyboard focus on the link shows the same background and a quiet
 * grey line inside the row, never a coloured ring.
 */
export function ClientRow({ client, children }: { client: ClientSummary; children: ReactNode }) {
  const entries = clientMenuEntries(useClientMenuActions(client), useIsAdmin());

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow
          data-client-id={client.clientId}
          tabIndex={-1}
          // 57 px: the board's 56 px row and the line under it.
          className="relative h-[57px] outline-none data-[state=open]:bg-muted/50 has-[a:focus-visible]:bg-muted/50 has-[a:focus-visible]:outline-solid has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-foreground/30"
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            openMenuFromKeyboard(event.currentTarget, event.target as Element);
          }}
        >
          {children}
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_WIDTH} aria-label={`Actions for ${client.name}`}>
        {entries.map((entry) =>
          entry.type === 'separator' ? (
            <ContextMenuSeparator key={entry.id} />
          ) : (
            <RowMenuItemView key={entry.id} item={entry} />
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
