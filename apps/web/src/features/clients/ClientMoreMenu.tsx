import { Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsAdmin } from '@/data';
import { MENU_WIDTH } from '../jobs/JobRow';
import { DROPDOWN_MENU_PARTS, RowMenuItemView } from '../jobs/row-menu-views';
import { clientPageMenuEntries } from './client-menu';
import type { ClientSummary } from './clients';
import { useClientMenuActions } from './use-client-menu-actions';

/**
 * The ⋯ beside Style in the header of a client's page (board CLPage): the client's row menu of the
 * Clients list as a menu from a button, with the same entries and dialogs (Instagram… while Clients
 * × Instagram is on; Assign to…, Rename…, Show in Finder and Delete… for the admin), without Open
 * and View style (see `clientPageMenuEntries`). A viewer who would have no entry has no button.
 */
export function ClientMoreMenu({ client }: { client: ClientSummary }) {
  const entries = clientPageMenuEntries(useClientMenuActions(client), useIsAdmin());
  if (entries.length === 0) return null;
  const label = `More for ${client.name}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* A native title, as the job sheet's ⋯ has (the board's button has one too). */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground dark:hover:bg-accent"
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={MENU_WIDTH}
        aria-label={`Actions for ${client.name}`}
      >
        {entries.map((entry) =>
          entry.type === 'separator' ? (
            <DropdownMenuSeparator key={entry.id} />
          ) : (
            <RowMenuItemView key={entry.id} item={entry} parts={DROPDOWN_MENU_PARTS} />
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
