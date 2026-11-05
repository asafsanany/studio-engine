import { Copy, ExternalLink, FileText, Link as LinkIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  labelText,
  type ReelMenuEntry,
  type ReelMenuIcon,
  type ReelMenuItem,
  type ReelMenuItemId,
  type ReelMenuJob,
  type ReelMenuLabel,
  type ReelMenuSubmenu,
} from './reel-menu';

const ICONS: Record<ReelMenuIcon, typeof Copy> = {
  instagram: ExternalLink,
  link: LinkIcon,
  job: FileText,
  unlink: X,
  copy: Copy,
};

/** The width of the menus (200 px of a reel with no video, 220 of a linked one, and 260 of the Link to job list on the boards). */
export const REEL_MENU_WIDTH = { unlinked: 'w-50', linked: 'w-55' } as const;
const LINK_LIST_WIDTH = 'w-65';

/** An entry's words, with the video's or client's name in its own direction. */
function Words({ label }: { label: ReelMenuLabel }): ReactNode {
  return (
    <span className="min-w-0 truncate">
      {label.before}
      {label.name !== null && <bdi>{label.name}</bdi>}
    </span>
  );
}

/** What choosing an entry does; the menu's owner knows the reel. */
export interface ReelMenuHandlers {
  onItem: (id: ReelMenuItemId) => void;
  /** A video of the Link to job list was chosen. */
  onLink: (job: ReelMenuJob) => void;
}

function ItemView({ item, onItem }: { item: ReelMenuItem; onItem: ReelMenuHandlers['onItem'] }) {
  const Icon = ICONS[item.icon];
  return (
    <ContextMenuItem
      disabled={item.disabled}
      onSelect={() => onItem(item.id)}
      // A disabled item that says why takes the pointer (a disabled one takes none), with the default cursor.
      title={item.disabled ? item.disabledReason : undefined}
      className={
        item.disabled && item.disabledReason !== undefined
          ? 'data-[disabled]:cursor-default data-[disabled]:pointer-events-auto'
          : undefined
      }
    >
      <Icon aria-hidden />
      <Words label={item.label} />
    </ContextMenuItem>
  );
}

/**
 * Link to job ▸: the list of the client's delivered and paid videos that no reel links yet, under
 * its heading, each with when it was delivered or paid at its end. With none it is one disabled
 * line that says so.
 */
function SubmenuView({
  submenu,
  onLink,
}: {
  submenu: ReelMenuSubmenu;
  onLink: ReelMenuHandlers['onLink'];
}) {
  const Icon = ICONS[submenu.icon];
  const { heading, jobs } = submenu;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Icon aria-hidden />
        <span>{labelText(submenu.label)}</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className={LINK_LIST_WIDTH} aria-label={labelText(submenu.label)}>
        {jobs.length === 0 ? (
          <ContextMenuItem disabled>{submenu.emptyLabel}</ContextMenuItem>
        ) : (
          <>
            <ContextMenuLabel className="px-2 pt-1.5 pb-1 text-xs font-normal text-muted-foreground">
              {heading.before}
              <bdi>{heading.name}</bdi>
              {heading.after}
            </ContextMenuLabel>
            {jobs.map((job) => (
              <ContextMenuItem
                key={job.jobId}
                onSelect={() => onLink(job)}
                className="justify-between gap-3"
              >
                <bdi className="min-w-0 truncate">{job.name}</bdi>
                <span className="text-xs whitespace-nowrap text-muted-foreground">{job.when}</span>
              </ContextMenuItem>
            ))}
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * The right-click menu of a reel (boards CLPage, S4, S5): the entries of `reelMenuEntries`, drawn
 * as the Jobs rows' menu is. Radix mounts the content only while the menu is open.
 */
export function ReelMenu({
  entries,
  linked,
  label,
  handlers,
}: {
  entries: readonly ReelMenuEntry[];
  /** The reel is linked to a video: its menu is a little wider. */
  linked: boolean;
  /** The menu's accessible name: "Actions for the reel of Tue 20 Oct". */
  label: string;
  handlers: ReelMenuHandlers;
}) {
  return (
    <ContextMenuContent
      className={linked ? REEL_MENU_WIDTH.linked : REEL_MENU_WIDTH.unlinked}
      aria-label={label}
    >
      {entries.map((entry) => {
        if (entry.type === 'separator') return <ContextMenuSeparator key={entry.id} />;
        if (entry.type === 'submenu') {
          return <SubmenuView key={entry.id} submenu={entry} onLink={handlers.onLink} />;
        }
        return <ItemView key={entry.id} item={entry} onItem={handlers.onItem} />;
      })}
    </ContextMenuContent>
  );
}
