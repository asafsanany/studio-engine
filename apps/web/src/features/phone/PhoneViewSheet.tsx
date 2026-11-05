import { X } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { Switch } from '@/components/ui/switch';

/** What the two rows say under their names. */
export const BY_CLIENT_TEXT = 'Each client’s jobs under its name';
export const SHOW_ARCHIVED_TEXT = 'Archived videos join their tabs, faded, with a box mark';

/** One row of the View sheet: the name (and a count), what it does, and the switch. The whole row is the target. */
function ViewSwitch({
  label,
  count,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  count?: number;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    // A label around the row, so a tap anywhere on it flips the switch (the switch is the one control).
    <label
      htmlFor={id}
      className="flex min-h-[60px] cursor-pointer items-center gap-3 border-t px-4 py-2 transition-colors duration-150 ease-in-out active:bg-white/5"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[15px]">
          {label}
          {count !== undefined && (
            <span className="text-muted-foreground tabular-nums">{count}</span>
          )}
        </span>
        <span className="text-[13px] text-pretty text-muted-foreground">{description}</span>
      </span>
      <Switch id={id} size="lg" checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

/**
 * View, as a bottom sheet (board MJobsView): the grabber, "View" with a 44 px close button, and two
 * switches as 60 px rows. "By client" is phone-only (jobs one step in under their client's name);
 * "Show archived", with how many jobs are archived, is the Mac's remembered switch. A stock Sheet
 * from the bottom, a stock Switch, the sheet's own close button left out for ours.
 */
export function PhoneViewSheet({
  open,
  onOpenChange,
  byClient,
  onByClientChange,
  showArchived,
  onShowArchivedChange,
  archivedCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  byClient: boolean;
  onByClientChange: (byClient: boolean) => void;
  showArchived: boolean;
  onShowArchivedChange: (showArchived: boolean) => void;
  /** How many jobs are archived; `undefined` until the list has loaded. */
  archivedCount: number | undefined;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        data-slot="phone-view-sheet"
        className="gap-0 rounded-t-2xl bg-card px-0 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] [-webkit-tap-highlight-color:transparent]"
      >
        <SheetGrabber onClose={() => onOpenChange(false)} className="mb-1" />
        <div className="flex items-center py-1 pr-1.5 pl-4">
          <SheetTitle className="flex-1 text-lg">View</SheetTitle>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close"
              className="size-11 text-muted-foreground"
            >
              <X className="size-5" aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>
        <SheetDescription className="sr-only">How the jobs list is shown.</SheetDescription>
        <ViewSwitch
          label="By client"
          description={BY_CLIENT_TEXT}
          checked={byClient}
          onCheckedChange={onByClientChange}
        />
        <ViewSwitch
          label="Show archived"
          count={archivedCount}
          description={SHOW_ARCHIVED_TEXT}
          checked={showArchived}
          onCheckedChange={onShowArchivedChange}
        />
      </SheetContent>
    </Sheet>
  );
}
