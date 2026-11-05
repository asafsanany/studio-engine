import { Settings2 } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface JobsViewMenuProps {
  /** Whether each client's jobs sit under its name. */
  byClient: boolean;
  onByClientChange: (byClient: boolean) => void;
  /** Whether archived jobs are shown. */
  showArchived: boolean;
  onShowArchivedChange: (showArchived: boolean) => void;
  /** How many jobs are archived, shown muted at the end of the item; `undefined` until the list has loaded. */
  archivedCount: number | undefined;
}

/**
 * The View button, a ghost button with the sliders icon, left of the search. It opens a stock
 * dropdown menu with two checkbox items: "By client" (each client's jobs under its name, as on the
 * phone) and "Show archived", with how many jobs are archived muted at its end. The app remembers
 * both; Show archived is the switch the client's page reads too. The menu opens
 * from the button's left edge (`align="start"`): on a narrow window the toolbar wraps and the button
 * sits at the left, where a menu hung from its right edge would cover the sidebar.
 *
 * Closing the menu hands focus back to the button, and Chrome counts that as keyboard focus: a ring
 * showed on the button after every mouse click. So when the menu was opened and used with the mouse
 * the focus is not handed back; a key press (Escape, Enter, the arrows) keeps the hand-back, with
 * the quiet keyboard ring.
 */
export function JobsViewMenu({
  byClient,
  onByClientChange,
  showArchived,
  onShowArchivedChange,
  archivedCount,
}: JobsViewMenuProps) {
  // Whether the mouse, not the keyboard, opened and used the menu.
  const withMouse = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 rounded-lg transition-colors duration-150 ease-in-out data-[state=open]:bg-accent dark:data-[state=open]:bg-accent"
          onPointerDown={() => {
            withMouse.current = true;
          }}
          onKeyDown={() => {
            withMouse.current = false;
          }}
        >
          <Settings2 aria-hidden />
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-55"
        onKeyDown={() => {
          withMouse.current = false;
        }}
        onCloseAutoFocus={(event) => {
          if (withMouse.current) event.preventDefault();
        }}
      >
        <DropdownMenuCheckboxItem
          checked={byClient}
          onCheckedChange={onByClientChange}
          className="h-8 py-0"
        >
          By client
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showArchived}
          onCheckedChange={onShowArchivedChange}
          className="h-8 py-0"
        >
          Show archived
          {archivedCount !== undefined && (
            <span className="ml-auto text-muted-foreground tabular-nums">{archivedCount}</span>
          )}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
