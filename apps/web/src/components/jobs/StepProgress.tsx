import { editingDetail, type Job, STEPS, stepLabel } from '@studio/shared';
import { cn } from '@/lib/utils';

export type SegmentState = 'done' | 'current' | 'pending';

/**
 * The eight segments for a job on `step` (1-8, or `null` when there is no current step): the
 * steps before it are done, it is the current one, the rest are pending. At Render all seven
 * earlier segments are done and the last one is the current one.
 */
export function segmentStates(step: Job['step']): SegmentState[] {
  return STEPS.map(({ id }) => {
    if (step === null || id > step) return 'pending';
    return id === step ? 'current' : 'done';
  });
}

const SEGMENT_CLASSES = {
  done: 'bg-status-editing',
  current: 'bg-status-editing/40',
  pending: 'bg-step-pending',
} as const satisfies Record<SegmentState, string>;

/** What StepProgress reads from a job. */
export type StepProgressJob = Pick<Job, 'step' | 'subProgress' | 'etaSec' | 'runKind' | 'round'>;

/**
 * The Status cell of an `editing` job: eight segments, one per step, then the step name with its
 * sub-count on the left ("Cut · graphics 2/5") and the run with the time left on the right: "~4 min
 * left" for an edit, "round 2 · ~4 min left" for a revise run, "approved · ~3 min left" for the
 * render. The right slot is empty (but still there) when there is nothing to say. The width comes
 * from the parent, so a 320 px column gives the board's 320 px bar.
 */
export function StepProgress({ job, className }: { job: StepProgressJob; className?: string }) {
  const states = segmentStates(job.step);
  const label = stepLabel(job);
  const detail = editingDetail(job);

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {/* The text row below says the same thing, so the bar is decoration for assistive tech. */}
      <div aria-hidden="true" className="flex gap-[3px]">
        {states.map((state, index) => (
          <div
            // The eight segments never reorder, so the position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered list of eight
            key={index}
            data-segment={state}
            className={cn('h-1.5 flex-1 rounded-[3px]', SEGMENT_CLASSES[state])}
          />
        ))}
      </div>
      <div className="flex justify-between gap-2 text-[13px] whitespace-nowrap">
        <span className="truncate font-medium">{label}</span>
        <span className="shrink-0 text-muted-foreground">{detail}</span>
      </div>
    </div>
  );
}
