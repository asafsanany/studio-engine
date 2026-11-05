import type { InstagramReel } from '@studio/shared';
import { CircleAlert, ExternalLink, Music } from 'lucide-react';
import type { MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CHANGE_TONE_CLASS, type ChangeTone } from '@/features/analytics/jobs-tiles-view';
import { isContextMenuKey, openMenuFromKeyboard } from '@/features/jobs/row-menu-key';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { InstagramCard } from './InstagramCard';
import { OURS, THEIRS } from './instagram-colors';
import { instantDayText, SEPARATOR, type TextOptions } from './instagram-text';
import { ReelMenu } from './ReelMenu';
import { type ReelMenuContext, type ReelMenuItemId, reelMenuEntries } from './reel-menu';
import {
  NO_REELS_FOR_FILTER,
  NO_REELS_YET,
  REEL_FILTER_LABELS,
  REEL_FILTERS,
  REELS_FOOTNOTE,
  REELS_PAGE_SIZE,
  type ReelFilter,
  type ReelRowView,
  reelRowView,
  reelsHint,
  soundWords,
  type TimesTone,
} from './reel-rows';
import { SegmentedSwitch } from './SegmentedSwitch';

const FILTER_OPTIONS = REEL_FILTERS.map((value) => ({ value, label: REEL_FILTER_LABELS[value] }));

/**
 * The columns of the list, on the board's grid: Posted, Caption (the rest of the width), Length,
 * Plays, × usual, Likes, Comm., Shares, Sound, With, Tags, Ours or theirs and the ghost button, 12 px
 * apart. The list is 1480 px wide at least and scrolls sideways inside its box.
 */
const REEL_COLUMNS =
  'grid grid-cols-[128px_minmax(220px,1fr)_52px_64px_60px_60px_56px_60px_150px_112px_120px_170px_32px] items-center gap-3 px-2';

const HEADINGS: ReadonlyArray<{ text: string; right: boolean }> = [
  { text: 'Posted', right: false },
  { text: 'Caption', right: false },
  { text: 'Length', right: true },
  { text: 'Plays', right: true },
  { text: '× usual', right: true },
  { text: 'Likes', right: true },
  { text: 'Comm.', right: true },
  { text: 'Shares', right: true },
  { text: 'Sound', right: false },
  { text: 'With', right: false },
  { text: 'Tags', right: false },
  { text: 'Ours or theirs', right: false },
  { text: '', right: false },
];

/** × usual is green from 2× up and red under 0.75×; between, and with no usual yet, it is quiet. */
const TIMES_TONE: Record<TimesTone, ChangeTone> = {
  high: 'better',
  low: 'worse',
  usual: 'same',
  unknown: 'same',
};

const NUMBER_CELL = 'text-right tabular-nums';

/**
 * The Sound cell's text: the song's name, then " · artist" a shade quieter, all on one line that is
 * cut at its end, so a long pair loses its artist first and the song's name shows whole (the board's
 * cell is the name alone, 150 px with the note in front). The whole "Song · Artist" is the tooltip.
 */
function SoundText({ sound }: { sound: string }) {
  const { song, artist } = soundWords(sound);
  return (
    <Bidi title={sound}>
      {song}
      {artist !== null && (
        <span className="text-muted-foreground/70">{`${SEPARATOR}${artist}`}</span>
      )}
    </Bidi>
  );
}

/** What the rows' menus and links do; the card that owns the list wires them to the page. */
export interface ReelsListActions {
  /** Open the job's sheet; `null` while the job sheet is off (the job's name is then plain text). */
  openJob: ((jobId: string) => void) | null;
  link: (reel: InstagramReel, job: { id: string; name: string }) => void;
  unlink: (reel: InstagramReel, job: { id: string; name: string }) => void;
  copyLink: (url: string) => void;
}

/** "Ours" (a blue dot and the video's name, a link to its sheet) or "Theirs" (a grey dot, quiet). */
function WhoseCell({
  job,
  openJob,
}: {
  job: ReelRowView['job'];
  openJob: ReelsListActions['openJob'];
}) {
  if (job === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ background: THEIRS }}
        />
        Theirs
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ background: OURS }}
      />
      {openJob === null ? (
        <Bidi>{job.name}</Bidi>
      ) : (
        <Bidi
          as="a"
          href={`?job=${encodeURIComponent(job.id)}`}
          onClick={(event: MouseEvent) => {
            // A new tab, window or download keeps the browser's own way.
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            openJob(job.id);
          }}
          className="text-foreground hover:underline"
        >
          {job.name}
        </Bidi>
      )}
    </span>
  );
}

/** The ghost button at the end of a row: the reel on Instagram, in a new tab. */
function OpenOnInstagram({ url }: { url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          asChild
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground dark:hover:bg-accent"
        >
          <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open on Instagram">
            <ExternalLink />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent align="end" sideOffset={6}>
        Open on Instagram
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One reel of the list, with its right-click menu (Shift+F10 and the menu key open it too, while
 * focus is inside the row). A quiet background while the pointer is over the row and while its menu
 * is open.
 */
function ReelRow({
  reel,
  menu,
  actions,
  textOptions,
}: {
  reel: InstagramReel;
  menu: ReelMenuContext;
  actions: ReelsListActions;
  textOptions?: TextOptions;
}) {
  const row = reelRowView(reel, textOptions);
  const day = instantDayText(reel.postedAt, textOptions);

  function onItem(id: ReelMenuItemId) {
    if (id === 'open-instagram') window.open(reel.url, '_blank', 'noopener,noreferrer');
    else if (id === 'copy-link') actions.copyLink(reel.url);
    else if (id === 'open-job' && reel.job !== null) actions.openJob?.(reel.job.id);
    else if (id === 'unlink' && reel.job !== null) actions.unlink(reel, reel.job);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-reel={reel.shortcode}
          data-ours={reel.job === null ? 'false' : 'true'}
          className={cn(
            REEL_COLUMNS,
            'min-h-11 border-b border-border/60 text-[13px] transition-colors duration-150 ease-in-out hover:bg-muted/60 data-[state=open]:bg-muted/60',
          )}
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            openMenuFromKeyboard(event.currentTarget, event.target as Element);
          }}
        >
          <span className="whitespace-nowrap text-muted-foreground">{row.posted}</span>
          {row.caption === null ? (
            <span className="truncate text-muted-foreground">No caption</span>
          ) : (
            <Bidi title={row.caption}>{row.caption}</Bidi>
          )}
          <span className={cn(NUMBER_CELL, 'text-muted-foreground')}>{row.length}</span>
          <span className={cn(NUMBER_CELL, 'font-medium')}>{row.plays}</span>
          <span className={cn(NUMBER_CELL, CHANGE_TONE_CLASS[TIMES_TONE[row.times.tone]])}>
            {row.times.text}
          </span>
          <span className={NUMBER_CELL}>{row.likes}</span>
          <span className={NUMBER_CELL}>{row.comments}</span>
          <span className={NUMBER_CELL}>{row.shares}</span>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Music aria-hidden className="size-3.5 shrink-0 text-[#8B8B94]" />
            <SoundText sound={row.sound} />
          </span>
          <Bidi className="text-muted-foreground" title={row.with}>
            {row.with}
          </Bidi>
          <span className="truncate text-muted-foreground" title={row.tags}>
            {row.tags}
          </span>
          <WhoseCell job={row.job} openJob={actions.openJob} />
          <OpenOnInstagram url={row.url} />
        </li>
      </ContextMenuTrigger>
      <ReelMenu
        entries={reelMenuEntries(reel, menu, textOptions)}
        linked={reel.job !== null}
        label={`Actions for the reel of ${day}`}
        handlers={{
          onItem,
          onLink: (job) => actions.link(reel, { id: job.jobId, name: job.name }),
        }}
      />
    </ContextMenu>
  );
}

/**
 * The Reels list (board CLPage): newest first, one row for each reel with everything a scan can
 * read, 1480 px wide at least inside a sideways scroller, and a right-click menu on every row. The
 * filter (All / Ours / Theirs) is in the card's head; ten rows show before Show all.
 */
export function ReelsList({
  reels,
  shown,
  filter,
  onFilterChange,
  showAll,
  onShowAllChange,
  subtitle,
  menu,
  actions,
  textOptions,
}: {
  /** The reels the filter lets through, newest first. */
  reels: readonly InstagramReel[];
  /** The rows on screen: the first ten of `reels`, or all of them. */
  shown: readonly InstagramReel[];
  filter: ReelFilter;
  onFilterChange: (filter: ReelFilter) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  subtitle: string;
  menu: ReelMenuContext;
  actions: ReelsListActions;
  textOptions?: TextOptions;
}) {
  const empty = reels.length === 0;
  return (
    <TooltipProvider>
      <InstagramCard
        title="Reels"
        subtitle={subtitle}
        action={
          <SegmentedSwitch
            label="Show"
            options={FILTER_OPTIONS}
            value={filter}
            onChange={onFilterChange}
          />
        }
      >
        {empty ? (
          <div className="flex min-h-24 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {filter === 'all' ? NO_REELS_YET : NO_REELS_FOR_FILTER[filter]}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[1480px]">
              <div
                aria-hidden="true"
                className={cn(
                  REEL_COLUMNS,
                  'border-b pb-2 text-xs font-medium text-muted-foreground',
                )}
              >
                {HEADINGS.map((heading) => (
                  <span key={heading.text} className={heading.right ? 'text-right' : undefined}>
                    {heading.text}
                  </span>
                ))}
              </div>
              <ul aria-label="Reels">
                {shown.map((reel) => (
                  <ReelRow
                    key={reel.shortcode}
                    reel={reel}
                    menu={menu}
                    actions={actions}
                    textOptions={textOptions}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
        {!empty && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted-foreground">
            <span>{reelsHint(shown.length, reels.length, menu.admin)}</span>
            {reels.length > REELS_PAGE_SIZE && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onShowAllChange(!showAll)}
                className="text-[13px] text-blue-300 hover:text-blue-200"
              >
                {showAll ? 'Show fewer' : 'Show all'}
              </Button>
            )}
          </div>
        )}
        <p className="flex items-center gap-1.5 text-xs text-[#8B8B94]">
          <CircleAlert aria-hidden className="size-3 shrink-0" />
          {REELS_FOOTNOTE}
        </p>
      </InstagramCard>
    </TooltipProvider>
  );
}
