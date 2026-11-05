import {
  homeCurrencySymbol,
  type Job,
  type JobStage,
  type JobState,
  jobStage,
} from '@studio/shared';
import type { ComponentProps } from 'react';
import { STATUS_LABELS } from '@/components/jobs/StatusBadge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * What an icon draws: a job's state, except that a ready job draws its stage (`jobStage`):
 * Approved (the green check), Delivered, Uploaded or Paid.
 */
export type IconKind = Exclude<JobState, 'ready'> | JobStage;

/** The icon of a job: its state, or for a ready job its stage. */
export function iconKindOf(job: Pick<Job, 'state' | 'delivery'>): IconKind {
  const stage = jobStage(job);
  if (stage !== null) return stage;
  // `jobStage` is null for every state but ready, and a ready job always has a stage.
  return job.state === 'ready' ? 'approved' : job.state;
}

/** The name of each icon, which is its accessible name and its tooltip. */
export const ICON_LABELS = {
  arriving: STATUS_LABELS.arriving,
  queued: STATUS_LABELS.queued,
  held: STATUS_LABELS.held,
  editing: STATUS_LABELS.editing,
  review: STATUS_LABELS.review,
  approved: STATUS_LABELS.ready,
  delivered: 'Delivered',
  uploaded: 'Uploaded',
  paid: 'Paid',
  failed: STATUS_LABELS.failed,
  cancelled: STATUS_LABELS.cancelled,
} as const satisfies Record<IconKind, string>;

/**
 * The text colour of each icon (a utility class, so Tailwind finds it). The icon draws itself in
 * `currentColor`, so this is its colour; arriving and queued share the neutral grey, and Approved
 * keeps the colour a ready job always had.
 */
export const STATUS_ICON_CLASSES = {
  arriving: 'text-status-neutral',
  queued: 'text-status-neutral',
  held: 'text-status-held',
  editing: 'text-status-editing',
  review: 'text-status-review',
  approved: 'text-status-ready',
  delivered: 'text-status-delivered',
  uploaded: 'text-status-uploaded',
  paid: 'text-status-paid',
  failed: 'text-status-failed',
  cancelled: 'text-status-cancelled',
} as const satisfies Record<IconKind, string>;

/** The circumference of the editing pie's circle (radius 2.5): 2π × 2.5, to three decimals. */
const PIE_LENGTH = 15.708;
const STEP_COUNT = 8;

/** How many of the eight steps are finished: the steps before the current one (0 to 7). */
function finishedSteps(step: Job['step']): number {
  return step === null ? 0 : step - 1;
}

/** A length along the pie's circle, to three decimals, so the markup does not carry 15 digits. */
const along = (steps: number) => Math.round((steps / STEP_COUNT) * PIE_LENGTH * 1000) / 1000;

/** The 1.5 px ring most states are drawn on. */
function Ring({ dashed = false }: { dashed?: boolean }) {
  return (
    <circle
      cx="8"
      cy="8"
      r="6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeDasharray={dashed ? '2.5 2.6' : undefined}
    />
  );
}

/** A filled disc with a mark cut out of it in the page's background colour (approved, delivered, uploaded, failed). */
function Disc() {
  return <circle cx="8" cy="8" r="7" fill="currentColor" />;
}

/**
 * The eight-step bar of an editing job, as a pie inside the ring: the finished steps are solid and
 * the current one is the same colour at 40 %, which is what the old segment bar showed. A job with
 * no current step has an empty pie.
 */
function Pie({ step }: { step: Job['step'] }) {
  const done = finishedSteps(step);
  return (
    <>
      <circle
        cx="8"
        cy="8"
        r="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        transform="rotate(-90 8 8)"
        strokeDasharray={`${along(done)} ${PIE_LENGTH}`}
      />
      {step !== null && (
        <circle
          cx="8"
          cy="8"
          r="2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          transform="rotate(-90 8 8)"
          strokeDasharray={`${along(1)} ${PIE_LENGTH}`}
          strokeDashoffset={-along(done)}
          opacity="0.4"
        />
      )}
    </>
  );
}

/** What is drawn inside the icon's 16 × 16 box, per icon. */
function Shapes({ kind, step }: { kind: IconKind; step: Job['step'] }) {
  switch (kind) {
    case 'arriving':
    case 'queued':
      return <Ring dashed />;
    case 'held':
      return (
        <>
          <Ring />
          <path
            d="M6.5 5.5v5M9.5 5.5v5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      );
    case 'editing':
      return (
        <>
          <Ring />
          <Pie step={step} />
        </>
      );
    case 'review':
      return (
        <>
          <Ring />
          <path d="M6.6 5.3v5.4L10.9 8z" fill="currentColor" />
        </>
      );
    case 'approved':
      return (
        <>
          <Disc />
          <path
            d="m5 8.2 2 2 4-4.2"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'delivered':
      return (
        <>
          <Disc />
          <path
            d="M4.8 8h6.1M8.4 5.4 11 8l-2.6 2.6"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'uploaded':
      return (
        <>
          <Disc />
          <path
            d="M8 11.2V4.8M5.4 7.4 8 4.8l2.6 2.6"
            fill="none"
            stroke="var(--background)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'paid':
      return (
        <>
          <Disc />
          {/* The shekel sign is text, in the page's font; the disc is the Paid grey. */}
          <text
            x="8"
            y="11.2"
            textAnchor="middle"
            fontSize="9.5"
            fontWeight="700"
            fill="var(--foreground)"
          >
            {homeCurrencySymbol()}
          </text>
        </>
      );
    case 'failed':
      return (
        <>
          <Disc />
          <path d="M8 4.6v4.2" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.2" r="0.95" fill="var(--background)" />
        </>
      );
    case 'cancelled':
      return (
        <>
          <Ring />
          <path
            d="M5.2 10.8 10.8 5.2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      );
  }
}

/**
 * The icon of a kind on its own: the 16 × 16 drawing in the kind's colour, at `size` px, with no
 * name and no tooltip. Anything else (`role`, `aria-label`, `data-*`) goes on the `<svg>`. The
 * Money page's "not paid yet" line draws the Delivered one at 14 px, so a delivered video looks
 * the same there as on the Jobs page.
 */
export function StatusGlyph({
  kind,
  step = null,
  size = 16,
  className,
  ...props
}: { kind: IconKind; step?: Job['step']; size?: number } & Omit<
  ComponentProps<'svg'>,
  'width' | 'height' | 'viewBox' | 'children'
>) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the caller names it (`role="img"` and `aria-label`) or hides it (`aria-hidden`)
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cn('block shrink-0', STATUS_ICON_CLASSES[kind], className)}
      {...props}
    >
      <Shapes kind={kind} step={step} />
    </svg>
  );
}

/**
 * A job's state as a 16 px icon, in the state's colour: a dashed ring for a job on its way
 * (arriving, queued), a ring with pause bars for held, a ring with a pie of the eight steps for
 * editing, a ring with a play triangle for review, a red disc with an exclamation mark for failed
 * and a ring with a slash for cancelled. A ready job draws its stage: a green disc with a check
 * (Approved), a sky disc with an arrow (Delivered), a violet disc with an arrow up (Uploaded: a
 * reel is linked to it) or a grey disc with a shekel sign (Paid).
 *
 * It is an image named after what it draws ("Approved", "Review", ...), and hovering it shows that
 * name in a tooltip. `data-status` is the job's state (a ready job is `ready` at every stage) and
 * `data-stage` is its stage (`approved`, `delivered`, `uploaded`, `paid`) while it is ready. An editing icon
 * also has `data-done`, the number of finished steps (0 to 7), for tests that read how far a job
 * has got.
 */
export function JobStatusIcon({ job }: { job: Pick<Job, 'state' | 'step' | 'delivery'> }) {
  const kind = iconKindOf(job);
  const label = ICON_LABELS[kind];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <StatusGlyph
          kind={kind}
          step={job.step}
          role="img"
          aria-label={label}
          data-status={job.state}
          data-stage={jobStage(job) ?? undefined}
          data-done={job.state === 'editing' ? finishedSteps(job.step) : undefined}
        />
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}
