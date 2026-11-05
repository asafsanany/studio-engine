import { absoluteTime, type DmItem, type DmItemKind, relativeTime } from '@studio/shared';
import {
  CircleDashed,
  CircleHelp,
  Download,
  ExternalLink,
  File,
  Film,
  Image,
  Link,
  type LucideIcon,
  MessageSquare,
  Music,
  Video,
} from 'lucide-react';
import { useNow } from '@/components/jobs/use-now';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { dmFileUrl } from '@/data';
import { cn } from '@/lib/utils';
import { DMS_TEXT, dmDetail, dmTitle, isInstagramLink } from './dm-text';

/** The icon of each kind, muted at the start of the row. */
export const DM_KIND_ICONS: Record<DmItemKind, LucideIcon> = {
  reel: Film,
  post: Image,
  story: CircleDashed,
  video: Video,
  photo: Image,
  audio: Music,
  file: File,
  link: Link,
  text: MessageSquare,
  unsupported: CircleHelp,
};

/** A row: the kind's icon, the title, the detail, the time and the one next-step button. */
const ROW_CLASSES =
  'grid h-11 cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto_80px_32px] items-center gap-3 rounded-lg pr-1.5 pl-3 outline-none transition-colors duration-150 ease-in-out hover:bg-muted/60 focus-visible:bg-muted/60 data-[open]:bg-muted/60 data-[state=open]:bg-muted/60';

export interface DmActions {
  open: (item: DmItem) => void;
  reveal: (item: DmItem) => void;
}

/** The item's link opened in a new tab. */
function openLink(link: string): void {
  window.open(link, '_blank', 'noopener,noreferrer');
}

/** The right-hand button: the download when there is a file, else the link, else nothing. */
function NextStep({ item }: { item: DmItem }) {
  if (item.file !== null) {
    return (
      <Button asChild variant="ghost" size="icon-sm" aria-label={DMS_TEXT.download}>
        <a
          href={dmFileUrl(item.file.name)}
          download={item.file.name}
          onClick={(event) => event.stopPropagation()}
        >
          <Download />
        </a>
      </Button>
    );
  }
  if (item.link !== null) {
    const label = isInstagramLink(item.link) ? DMS_TEXT.openOnInstagram : DMS_TEXT.openLink;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          if (item.link !== null) openLink(item.link);
        }}
      >
        <ExternalLink />
      </Button>
    );
  }
  return <span />;
}

/** The right-click menu of a row: everything the row can do. */
function DmMenu({ item, actions }: { item: DmItem; actions: DmActions }) {
  const { link, file, text } = item;
  return (
    <ContextMenuContent className="w-52" aria-label={`Actions for ${dmTitle(item)}`}>
      <ContextMenuItem onSelect={() => actions.open(item)}>{DMS_TEXT.open}</ContextMenuItem>
      {file !== null && (
        <>
          <ContextMenuItem asChild>
            <a href={dmFileUrl(file.name)} download={file.name}>
              {DMS_TEXT.download}
            </a>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => actions.reveal(item)}>{DMS_TEXT.reveal}</ContextMenuItem>
        </>
      )}
      {(link !== null || text !== null) && <ContextMenuSeparator />}
      {link !== null && (
        <>
          <ContextMenuItem onSelect={() => openLink(link)}>
            {isInstagramLink(link) ? DMS_TEXT.openOnInstagram : DMS_TEXT.openLink}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(link)}>
            {DMS_TEXT.copyLink}
          </ContextMenuItem>
        </>
      )}
      {text !== null && (
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(text)}>
          {DMS_TEXT.copyText}
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

/** The row next to `row` (↑ and ↓ move between rows; the list is one Tab stop, like Jobs). */
function rowBeside(row: HTMLElement, step: 1 | -1): HTMLElement | null {
  const next = step === 1 ? row.nextElementSibling : row.previousElementSibling;
  return next instanceof HTMLElement ? next : null;
}

function DmRow({
  item,
  now,
  openId,
  tabStop,
  actions,
}: {
  item: DmItem;
  now: number;
  openId: string | null;
  /** The list's one Tab stop: the first row. */
  tabStop: boolean;
  actions: DmActions;
}) {
  const Icon = DM_KIND_ICONS[item.kind];
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-dm-id={item.id}
          data-open={openId === item.id ? '' : undefined}
          tabIndex={tabStop ? 0 : -1}
          className={ROW_CLASSES}
          onClick={() => actions.open(item)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              actions.open(item);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              rowBeside(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)?.focus();
            }
          }}
        >
          <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            <bdi>{dmTitle(item)}</bdi>
          </span>
          <span
            className={cn(
              'text-[13px] whitespace-nowrap text-muted-foreground',
              item.missing !== null && 'text-amber-500',
            )}
            title={item.missing ?? undefined}
          >
            {dmDetail(item)}
          </span>
          <time
            dateTime={item.at}
            title={absoluteTime(item.at)}
            className="text-right text-[13px] whitespace-nowrap text-muted-foreground"
          >
            {relativeTime(item.at, now)}
          </time>
          <NextStep item={item} />
        </li>
      </ContextMenuTrigger>
      <DmMenu item={item} actions={actions} />
    </ContextMenu>
  );
}

/** The items, newest first, as the Jobs page's quiet list. */
export function DmList({
  items,
  openId,
  actions,
}: {
  items: readonly DmItem[];
  openId: string | null;
  actions: DmActions;
}) {
  const now = useNow();
  return (
    <ul aria-label="DM items" className="flex flex-col gap-0.5">
      {items.map((item, index) => (
        <DmRow
          key={item.id}
          item={item}
          now={now}
          openId={openId}
          tabStop={index === 0}
          actions={actions}
        />
      ))}
    </ul>
  );
}
