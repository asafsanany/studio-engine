import { isArchived, type Job, jobStage } from '@studio/shared';
import { type ComponentType, Fragment, type ReactNode, useMemo } from 'react';
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useClientStyle,
  useIsAdmin,
  useJobSheetEnabled,
  useJobs,
  useQuickFixesEnabled,
} from '@/data';
import { usePhoneLayout } from '@/features/phone/use-phone-layout';
import { NOT_IN_A_SERIES_OPTION, SERIES_SUBMENU_ID } from '@/features/series/series-menu';
import { useSeriesMenu } from '@/features/series/use-series-menu';
import { cn } from '@/lib/utils';
import type { RowActions } from './cells/use-row-actions';
import {
  type ArchiveMenuContext,
  type JobMenuEntry,
  type RowMenuItem,
  type RowMenuSubmenu,
  rowMenuEntries,
  withDeleteEntry,
} from './row-menu';

/**
 * The pieces a job's menu is drawn with. The row's right-click menu uses the ContextMenu ones and
 * the job sheet's ⋯ menu the DropdownMenu ones: the two sets share their look and their props, so
 * one set of views draws the same entries in either, item for item.
 */
export interface MenuParts {
  Item: ComponentType<{
    variant?: 'default' | 'destructive';
    disabled?: boolean;
    onSelect?: () => void;
    asChild?: boolean;
    title?: string;
    className?: string;
    children?: ReactNode;
  }>;
  Separator: ComponentType<Record<never, never>>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ disabled?: boolean; className?: string; children?: ReactNode }>;
  SubContent: ComponentType<{
    className?: string;
    'aria-label'?: string;
    children?: ReactNode;
  }>;
  RadioGroup: ComponentType<{
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }>;
  RadioItem: ComponentType<{ value: string; className?: string; children?: ReactNode }>;
}

/** The right-click menu's pieces (a row's, a client's). */
export const CONTEXT_MENU_PARTS: MenuParts = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
};

/** The ⋯ button's menu pieces (the job sheet's). */
export const DROPDOWN_MENU_PARTS: MenuParts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
};

/**
 * What "Archive all paid · N" counts: the paid jobs that are not archived, across the whole list.
 * Only a Paid row's menu has the item, so only that menu reads the list.
 */
function useArchiveMenuContext(job: Job): ArchiveMenuContext {
  const { data: jobs } = useJobs();
  const paid = jobStage(job) === 'paid' && !isArchived(job);
  return useMemo(
    () => ({
      paidIds: paid
        ? (jobs ?? []).filter((j) => jobStage(j) === 'paid' && !isArchived(j)).map((j) => j.id)
        : [],
    }),
    [paid, jobs],
  );
}

/**
 * The entries of a job's menu, with what they depend on read for it: an approved job asks for its
 * client's style (the item "Use this look" is disabled when the look already comes from this job),
 * a Paid job reads the job list for "Archive all paid · N", and the series items read the client's
 * series. Call it where the menu's content is, which Radix mounts only while the menu is open, so
 * the reads happen when a menu opens, not for every row when the page loads.
 */
export function useRowMenuEntries(
  job: Job,
  actions: RowActions,
  { versions = false, approve = false }: { versions?: boolean; approve?: boolean } = {},
): JobMenuEntry[] {
  const style = useClientStyle(job.clientId, { enabled: jobStage(job) === 'approved' });
  const series = useSeriesMenu(job);
  const archive = useArchiveMenuContext(job);
  const admin = useIsAdmin();
  const quickFixes = useQuickFixesEnabled();
  return rowMenuEntries(
    job,
    actions,
    style.data?.sourceJobId ?? null,
    series,
    archive,
    admin,
    versions,
    quickFixes,
    approve,
  );
}

/** The width of a submenu's list (248 px on the Effort board). */
const SUBMENU_WIDTH = 'w-62';

/** The Series submenu's list is narrower (220 px on the SeriesJobs board): it holds names, no hints. */
const SERIES_SUBMENU_WIDTH = 'w-55';

/**
 * A submenu of a job's menu ("Effort ▸"): the item opens a list of radio items, the one in use
 * checked, each with a muted hint at its end. The item shows the choice in use at its end, in
 * front of the arrow; when it is disabled (the edit has started) it still says what the run uses.
 */
export function RowMenuSubmenuView({
  entry,
  parts = CONTEXT_MENU_PARTS,
}: {
  entry: RowMenuSubmenu;
  parts?: MenuParts;
}) {
  const { Sub, SubTrigger, SubContent, RadioGroup, RadioItem, Separator } = parts;
  const Icon = entry.icon;
  const isSeries = entry.id === SERIES_SUBMENU_ID;
  return (
    <Sub>
      <SubTrigger
        disabled={entry.disabled}
        // The arrow pushes itself to the end; with a trailing word the word does, and the arrow follows it.
        className={cn(
          'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
          entry.trailing !== null && '[&>svg:last-child]:ml-0',
        )}
      >
        <Icon aria-hidden />
        <span>{entry.label}</span>
        {entry.trailing !== null && (
          <span className="ml-auto text-[13px] text-muted-foreground">{entry.trailing}</span>
        )}
      </SubTrigger>
      <SubContent
        className={isSeries ? SERIES_SUBMENU_WIDTH : SUBMENU_WIDTH}
        aria-label={entry.label}
      >
        <RadioGroup value={entry.value} onValueChange={entry.onValueChange}>
          {entry.options.map((option) => (
            <Fragment key={option.id}>
              <RadioItem
                value={option.id}
                // "Not in a series" is quieter than the series themselves.
                className={cn(
                  isSeries && option.id === NOT_IN_A_SERIES_OPTION && 'text-muted-foreground',
                )}
              >
                {/* A series' name is the person's own, in Hebrew, Latin or mixed. */}
                {isSeries && option.id !== NOT_IN_A_SERIES_OPTION ? (
                  <bdi>{option.label}</bdi>
                ) : (
                  <span>{option.label}</span>
                )}
                {option.hint !== '' && (
                  <span className="ml-auto text-xs text-muted-foreground">{option.hint}</span>
                )}
              </RadioItem>
              {option.separatorAfter === true && <Separator />}
            </Fragment>
          ))}
        </RadioGroup>
      </SubContent>
    </Sub>
  );
}

/** The item's text, with the name that belongs to the person (`bidi`) in its own direction. */
export function RowMenuItemLabel({ label, bidi }: Pick<RowMenuItem, 'label' | 'bidi'>) {
  const at = bidi === undefined ? -1 : label.indexOf(bidi);
  if (bidi === undefined || at < 0) return label;
  // One element, not three flex items with the menu item's gap between them.
  return (
    <span>
      {label.slice(0, at)}
      <bdi>{bidi}</bdi>
      {label.slice(at + bidi.length)}
    </span>
  );
}

/** One item of a menu: a row's right-click menu (also the Clients page's) or the sheet's ⋯. */
export function RowMenuItemView({
  item,
  parts = CONTEXT_MENU_PARTS,
}: {
  item: RowMenuItem;
  parts?: MenuParts;
}) {
  const { Item } = parts;
  const Icon = item.icon;
  const content = (
    <>
      <Icon aria-hidden />
      <RowMenuItemLabel label={item.label} bidi={item.bidi} />
    </>
  );
  return (
    <Item
      variant={item.destructive ? 'destructive' : 'default'}
      disabled={item.disabled}
      onSelect={item.onSelect}
      asChild={item.href !== undefined}
      // A disabled item that says why takes the pointer (a disabled one takes none), with the default cursor.
      title={item.disabled ? item.disabledReason : undefined}
      className={
        item.disabled && item.disabledReason !== undefined
          ? 'data-[disabled]:cursor-default data-[disabled]:pointer-events-auto'
          : undefined
      }
    >
      {item.href === undefined ? (
        content
      ) : (
        <a href={item.href} download>
          {content}
        </a>
      )}
    </Item>
  );
}

/** A job's menu drawn from its entries: items, lines and the Effort / Series submenus. */
export function RowMenuEntryViews({
  entries,
  parts = CONTEXT_MENU_PARTS,
}: {
  entries: readonly JobMenuEntry[];
  parts?: MenuParts;
}) {
  const { Separator } = parts;
  return entries.map((entry) => {
    if (entry.type === 'separator') return <Separator key={entry.id} />;
    if (entry.type === 'submenu') {
      return <RowMenuSubmenuView key={entry.id} entry={entry} parts={parts} />;
    }
    return <RowMenuItemView key={entry.id} item={entry} parts={parts} />;
  });
}

/**
 * The content of a job's menu: its entries, read for the menu when it opens (see
 * `useRowMenuEntries`). Put it inside the menu's content, so it is mounted only while the menu is
 * open.
 */
export function RowMenuEntries({
  job,
  actions,
  parts = CONTEXT_MENU_PARTS,
  withDelete = false,
  withApprove = false,
}: {
  job: Job;
  actions: RowActions;
  parts?: MenuParts;
  /** Ends the menu with Delete… (the row's right-click menu). */
  withDelete?: boolean;
  /** A job in Review has Approve after Review… (the row's right-click menu, never the sheet's ⋯). */
  withApprove?: boolean;
}) {
  // "Versions…" opens the Mac's job sheet at its Versions part: not where the sheet is off or the phone's.
  const sheetOn = useJobSheetEnabled();
  const phone = usePhoneLayout();
  const versions = sheetOn && !phone;
  const rowEntries = useRowMenuEntries(job, actions, { versions, approve: withApprove });
  // Delete… is the admin's: it removes the folder, the export and the payment record.
  const admin = useIsAdmin();
  const entries = withDelete && admin ? withDeleteEntry(job, rowEntries) : rowEntries;
  return <RowMenuEntryViews entries={entries} parts={parts} />;
}
