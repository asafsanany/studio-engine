import type { Job } from '@studio/shared';
import { Check, ChevronDown } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useJobSteps, useSentNotes } from '@/data';
import { cn } from '@/lib/utils';
import { SKELETON_DELAY_MS, useDelayedFlag } from '../jobs/delayed-flag';
import { type IconKind, StatusGlyph } from '../jobs/JobStatusIcon';
import {
  buildSteps,
  STEPS_TEXT,
  type StepRow,
  type StepRowKind,
  type StepsView,
} from './sheet-steps';

/** The colour of a row's step name: the pending ones and the waiting one are muted or violet. */
const NAME_CLASSES: Record<StepRowKind, string> = {
  done: '',
  running: '',
  failed: '',
  stopped: '',
  pending: 'text-zinc-500',
  waiting: 'text-violet-300',
};

/** The colour of a row's text on the right. */
const TEXT_CLASSES: Record<StepRowKind, string> = {
  done: 'text-muted-foreground',
  running: 'text-blue-300',
  failed: 'text-status-failed-foreground',
  stopped: 'text-muted-foreground',
  pending: 'text-muted-foreground',
  waiting: 'text-violet-300',
};

/** One of the app's own status icons, named for assistive tech. */
function Glyph({
  kind,
  label,
  step,
  className,
}: {
  kind: IconKind;
  label: string;
  step?: StepRow['step'];
  className?: string;
}) {
  return (
    <StatusGlyph kind={kind} step={step} className={className} role="img" aria-label={label} />
  );
}

/** The icon of a row: the app's own status icons, and a plain check for a finished step. */
function RowIcon({ row }: { row: StepRow }) {
  switch (row.kind) {
    case 'done':
      return (
        <Check role="img" aria-label="Done" strokeWidth={2.4} className="size-4 text-zinc-500" />
      );
    case 'running':
      return <Glyph kind="editing" step={row.step} label="Running now" />;
    case 'failed':
      return <Glyph kind="failed" label="Failed" />;
    case 'stopped':
      return <Glyph kind="cancelled" label="Stopped" />;
    case 'waiting':
      return <Glyph kind="review" label="Waiting for you" />;
    case 'pending':
      return <Glyph kind="queued" label="Not started" className="text-zinc-600" />;
  }
}

function Row({ row }: { row: StepRow }) {
  return (
    <li
      data-step={row.key}
      data-kind={row.kind}
      className="grid min-h-7 grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5"
    >
      <RowIcon row={row} />
      <span className={cn('truncate', NAME_CLASSES[row.kind])}>{row.name}</span>
      <span className={cn('text-[13px] whitespace-nowrap tabular-nums', TEXT_CLASSES[row.kind])}>
        {row.text}
      </span>
    </li>
  );
}

/** The small muted line that opens a later round of a finished job's list: "Round 2 · from Plan". */
function RoundHeading({ text }: { text: string }) {
  return (
    <li data-slot="job-sheet-steps-round" className="mt-2 text-xs text-zinc-500">
      {text}
    </li>
  );
}

/** The widths of the bars the loading rows draw, so they do not look like a table. */
const SKELETON_WIDTHS = ['70%', '62%', '74%', '58%', '66%', '60%', '72%', '56%'] as const;

function SkeletonRows() {
  return (
    <div aria-busy="true" className="flex flex-col gap-0.5">
      {SKELETON_WIDTHS.map((width) => (
        <div key={width} className="flex h-7 items-center">
          <Skeleton className="h-3 rounded" style={{ width }} />
        </div>
      ))}
      <span role="status" className="sr-only">
        Loading the steps
      </span>
    </div>
  );
}

export interface StepsPanelProps {
  /** What to say; `null` while the steps are loading or when they could not be loaded. */
  view: StepsView | null;
  /** The steps could not be loaded (and nothing older is kept). */
  failed: boolean;
  /** The loading rows are due (the wait has been long enough to be worth drawing them). */
  showSkeleton: boolean;
  /** A finished job's rows are open. */
  open: boolean;
  onToggle: () => void;
}

/**
 * The Steps section as it looks: the heading with its muted label, then the rows, or for a
 * finished job one folded line (check, "All 8 steps done · 26 min of work", chevron) that opens
 * them: the first cut, then each round of notes under its own small sub-heading, Render last. While the steps load there is nothing under the heading, until the skeleton rows are due;
 * if they cannot be loaded there is one muted line.
 */
export function StepsPanel({ view, failed, showSkeleton, open, onToggle }: StepsPanelProps) {
  const listId = useId();
  const folded = view?.summary != null;
  // A folded line says it all; the label comes back with the rows.
  const label = view === null || (folded && !open) ? '' : view.label;

  const list = view && (
    <ol id={listId} className="m-0 flex list-none flex-col gap-0.5 p-0">
      {view.rows.map((row) => (
        <Fragment key={`${row.round}-${row.key}`}>
          {row.heading !== null && <RoundHeading text={row.heading} />}
          <Row row={row} />
        </Fragment>
      ))}
    </ol>
  );

  return (
    <section
      aria-label={STEPS_TEXT.heading}
      data-slot="job-sheet-steps"
      className="flex flex-col gap-0.5"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">{STEPS_TEXT.heading}</h3>
        <span className="text-xs text-zinc-500">{label}</span>
      </div>
      {failed ? (
        <p className="text-muted-foreground">{STEPS_TEXT.loadFailed}</p>
      ) : view === null ? (
        showSkeleton ? (
          <SkeletonRows />
        ) : null
      ) : folded ? (
        <>
          <Button
            type="button"
            variant="ghost"
            aria-expanded={open}
            aria-controls={listId}
            onClick={onToggle}
            className="-mx-2 grid h-auto min-h-8 grid-cols-[16px_minmax(0,1fr)_16px] justify-normal gap-2.5 px-2 py-1.5 text-left font-normal"
          >
            <Check aria-hidden="true" strokeWidth={2.4} className="size-4 text-zinc-500" />
            <span className="whitespace-normal">{view.summary}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-4 text-zinc-500 transition-transform duration-150 ease-in-out',
                open && 'rotate-180',
              )}
            />
          </Button>
          {open && list}
        </>
      ) : (
        list
      )}
    </section>
  );
}

/** The part that reads the steps and the clock; keyed by job, so each job's rows start folded. */
function StepsSection({
  job,
  skeletonDelayMs,
  initiallyOpen,
}: {
  job: Job;
  skeletonDelayMs: number;
  initiallyOpen: boolean;
}) {
  const steps = useJobSteps(job.id, { enabled: true });
  // A finished job's rows count the notes each round was sent with; a job that has sent no round has
  // none, so nothing is asked of the engine for it. Without them the rows still read "notes sent".
  const sent = useSentNotes(job.id, { enabled: job.round > 0 });
  const now = useNow();
  const [open, setOpen] = useState(initiallyOpen);

  // The app's queries retry for ever, so a read that fails (the engine is down) stays pending with
  // `failureCount` above 0; a 4xx is an error at once. Either way, with nothing to show, say so.
  const failed = steps.data === undefined && (steps.isError || steps.failureCount > 0);
  const showSkeleton = useDelayedFlag(steps.data === undefined && !failed, skeletonDelayMs);
  const view =
    steps.data === undefined
      ? null
      : buildSteps(job, steps.data.runs, { now, notes: sent.data?.notes });

  return (
    <StepsPanel
      view={view}
      failed={failed}
      showSkeleton={showSkeleton}
      open={open}
      onToggle={() => setOpen((was) => !was)}
    />
  );
}

/**
 * The sheet's "Steps" part: the steps of the job's current round with their start time and length,
 * the running one blue, a failed one red, "Your review" between Check and Render; a revise round
 * shows the round's own steps; a finished job folds them into one line, and opened tells the whole
 * story: the first cut, each review round after it, Render last. Reads `useJobSteps(job.id)` (the
 * sheet mounts this only while it is open), the notes that were sent (for the counts) and the job
 * itself.
 *
 * Design: canvas page "Job sheet", boards JSSheet, JSStatesA and JSStatesB (JS4, CVP-217).
 * `skeletonDelayMs` is how long loading takes before the skeleton rows show; tests pass 0, and
 * `initiallyOpen` to see a finished job's rows without a click.
 */
export function JobSheetSteps({
  job,
  skeletonDelayMs = SKELETON_DELAY_MS,
  initiallyOpen = false,
}: {
  job: Job;
  skeletonDelayMs?: number;
  initiallyOpen?: boolean;
}) {
  return (
    <StepsSection
      key={job.id}
      job={job}
      skeletonDelayMs={skeletonDelayMs}
      initiallyOpen={initiallyOpen}
    />
  );
}
