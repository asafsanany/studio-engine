import { isFolderDeleted, type Job } from '@studio/shared';
import { Ellipsis, Folder } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsAdmin, useRevealJob, useSeriesEnabled } from '@/data';
import type { RowActions } from '@/features/jobs/cells/use-row-actions';
import { menuWidth } from '@/features/jobs/JobRow';
import { DROPDOWN_MENU_PARTS, RowMenuEntries } from '@/features/jobs/row-menu-views';
import { cn } from '@/lib/utils';

/** The tooltip of Show in Finder: the MP4 once the job has one, the folder until then. */
export function revealLabel(job: Pick<Job, 'output'>): string {
  return job.output === null ? 'Show the folder in Finder' : 'Show the MP4 in Finder';
}

/**
 * A 32 px ghost icon button with its tooltip, which is also its accessible name. The accent
 * background fades in on hover, as on the list's action buttons.
 */
function ToolButton({
  label,
  children,
  className,
  ...props
}: {
  label: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, 'children' | 'aria-label'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className={cn(
            'text-muted-foreground hover:text-foreground dark:hover:bg-accent',
            className,
          )}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Show in Finder: the job's MP4 once it exists, its folder before. A refusal is said by a toast. */
function RevealButton({ job }: { job: Job }) {
  const reveal = useRevealJob();
  return (
    <ToolButton
      label={revealLabel(job)}
      disabled={reveal.isPending}
      onClick={() => reveal.mutate(job.id)}
    >
      <Folder aria-hidden />
    </ToolButton>
  );
}

/**
 * The ⋯ button: the row's right-click menu, item for item, as a menu from a button (the entries
 * come from `rowMenuEntries`, drawn by the same views). It acts on the row's set of requests
 * (`actions`), so a press here disables the buttons that do the same thing.
 */
function MoreMenu({ job, actions }: { job: Job; actions: RowActions }) {
  // The row's menu width, which is wider for an episode while series are on.
  const seriesOn = useSeriesEnabled();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* A native title, not a tooltip: closing the menu with Esc hands the focus back to this
            button, and a tooltip that opens for it would take the next Esc away from the panel. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="More actions"
          title="More"
          className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground dark:hover:bg-accent"
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className={menuWidth(job, seriesOn)}
        aria-label={`Actions for ${job.name}`}
      >
        <RowMenuEntries job={job} actions={actions} parts={DROPDOWN_MENU_PARTS} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Show in Finder (the admin's only; a video whose folder was deleted has nothing to show) and ⋯
 * (the row's menu), at the top right of the job's panel under its row.
 */
export function JobPanelTools({ job, actions }: { job: Job; actions: RowActions }) {
  const admin = useIsAdmin();
  return (
    <div className="flex items-center gap-0.5">
      {admin && !isFolderDeleted(job) && <RevealButton job={job} />}
      <MoreMenu job={job} actions={actions} />
    </div>
  );
}
