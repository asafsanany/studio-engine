import { type Job, type JobState, statusDetail, type TimeInput } from '@studio/shared';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The badge text for each state. The only place these words live. */
export const STATUS_LABELS = {
  arriving: 'Arriving',
  queued: 'Queued',
  held: 'Held',
  editing: 'Editing',
  review: 'Review',
  // A ready job is Approved until it is marked delivered; the Jobs list names the later stages itself.
  ready: 'Approved',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const satisfies Record<JobState, string>;

/**
 * The dot colour for each state (a utility class, so Tailwind finds it). Also what the header
 * counters use: arriving and queued share the neutral grey.
 */
export const STATUS_DOT_CLASSES = {
  arriving: 'bg-status-neutral',
  queued: 'bg-status-neutral',
  held: 'bg-status-held',
  editing: 'bg-status-editing',
  review: 'bg-status-review',
  ready: 'bg-status-ready',
  failed: 'bg-status-failed',
  cancelled: 'bg-status-cancelled',
} as const satisfies Record<JobState, string>;

/** What the badges read from a job. */
export type StatusBadgeJob = Pick<
  Job,
  | 'state'
  | 'placeInLine'
  | 'settlesAt'
  | 'output'
  | 'failedAt'
  | 'stoppedAt'
  | 'error'
  | 'preview'
  | 'round'
>;

interface StatusBadgeProps {
  job: StatusBadgeJob;
  /** The current time, for the "settles in 0:42" countdown. The caller owns the clock. */
  now: TimeInput;
  /** Grey text next to the badge instead of the state's own detail ("while you write a note"). */
  detail?: string;
  className?: string;
}

/**
 * The Status cell for every state except `editing`, which the table shows as a StepProgress
 * instead (an `editing` job still renders a plain "Editing" badge here, for places that need one).
 * Outline badge with a coloured dot, then the grey detail text: "settles in 0:42", "#2 in line",
 * "0:28 · 1080×1920 · round 2", "0:45 · 1080×1920 · 62 MB", "at Plan". A failed job is handed to
 * FailedBadge.
 */
export function StatusBadge({ job, now, detail: override, className }: StatusBadgeProps) {
  if (job.state === 'failed') return <FailedBadge job={job} now={now} className={className} />;

  const detail = override ?? statusDetail(job, now);
  return (
    <div className={cn('flex items-center gap-2 overflow-hidden whitespace-nowrap', className)}>
      <Badge variant="outline" data-status={job.state}>
        <BadgeDot className={STATUS_DOT_CLASSES[job.state]} />
        {STATUS_LABELS[job.state]}
      </Badge>
      {detail !== '' && (
        <span className="truncate text-muted-foreground tabular-nums">{detail}</span>
      )}
    </div>
  );
}

/**
 * "Failed at Render": the red tint badge. Hovering or focusing it shows the error message in a
 * wide tooltip. A failed job with no error text gets the same badge without the tooltip.
 */
export function FailedBadge({ job, now, className }: StatusBadgeProps) {
  const step = statusDetail(job, now);
  const badge = (
    <>
      <BadgeDot className={STATUS_DOT_CLASSES.failed} />
      {step === '' ? STATUS_LABELS.failed : `${STATUS_LABELS.failed} ${step}`}
    </>
  );

  if (job.error === null) {
    return (
      <Badge variant="destructive" data-status="failed" className={className}>
        {badge}
      </Badge>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge asChild variant="destructive">
          <button type="button" data-status="failed" className={cn('cursor-help', className)}>
            {badge}
          </button>
        </Badge>
      </TooltipTrigger>
      {/* Below the badge, left edges aligned, 6 px away: as on the Jobs board. */}
      <TooltipContent wide side="bottom" align="start" sideOffset={6} dir="auto">
        {job.error}
      </TooltipContent>
    </Tooltip>
  );
}
