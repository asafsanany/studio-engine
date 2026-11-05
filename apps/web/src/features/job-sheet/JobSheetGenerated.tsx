import type { GenerateSheetRow, GenerateTone, Job } from '@studio/shared';
import { useGenerateReviewPlan, useJobGenerateHistory } from '@/data';
import { cn } from '@/lib/utils';
import { GENERATED_TEXT, type GeneratedView, sheetGenerated } from './sheet-generated';
import type { SheetVariant } from './sheet-variant';

/** The colour of a row's value: normal, muted (not started), amber (the money ran out) or red (over the budget). */
const VALUE_CLASSES: Record<GenerateTone, string> = {
  normal: '',
  muted: 'text-zinc-500',
  warn: 'text-amber-400',
  error: 'text-red-300',
};

/** The colour of a row's bar: the blue of a step at work, grey for a run that stopped, amber for spent money. */
const BAR_CLASSES = {
  normal: 'bg-status-editing',
  muted: 'bg-zinc-500',
  warn: 'bg-amber-400',
} as const;

function Row({ row, phone }: { row: GenerateSheetRow; phone: boolean }) {
  return (
    <div
      data-generated={row.key}
      className={cn(
        'grid items-baseline gap-x-3 py-1',
        phone ? 'grid-cols-[112px_minmax(0,1fr)]' : 'grid-cols-[96px_minmax(0,1fr)]',
      )}
    >
      <dt className="text-muted-foreground">{row.key}</dt>
      <dd className="flex min-w-0 flex-col gap-1">
        <span className={cn('tabular-nums', VALUE_CLASSES[row.tone])}>{row.value}</span>
        {row.barPercent !== undefined && (
          <span
            aria-hidden="true"
            data-bar={row.barTone ?? 'normal'}
            className="block h-1 overflow-hidden rounded-full bg-muted"
          >
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-300 ease-in-out',
                BAR_CLASSES[row.barTone ?? 'normal'],
              )}
              style={{ width: `${row.barPercent}%` }}
            />
          </span>
        )}
        {row.sub !== undefined && (
          <span className="text-[13px] text-pretty text-muted-foreground">{row.sub}</span>
        )}
      </dd>
    </div>
  );
}

/** The part as it looks: the heading with who made what, then a row each for the voice, the looks, the keyframes, the clips and the spend. */
export function GeneratedPanel({
  view,
  variant = 'mac',
}: {
  view: GeneratedView;
  variant?: SheetVariant;
}) {
  return (
    <section
      aria-label={GENERATED_TEXT.heading}
      data-slot="job-sheet-generated"
      className="flex flex-col gap-0.5"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">{GENERATED_TEXT.heading}</h3>
        <span className="text-xs text-zinc-500">{GENERATED_TEXT.services}</span>
      </div>
      <dl>
        {view.rows.map((row) => (
          <Row key={row.key} row={row} phone={variant === 'phone'} />
        ))}
      </dl>
    </section>
  );
}

/**
 * The sheet's "Generated" part (Generated videos, GN9; board GNSheet): for a job that was made
 * without footage, what the Generate stage made and what it spent on Higgsfield, with a bar for
 * what is under way. It reads the job's own Generate state (kept current by `job.generate`), the
 * stage's History for the length of the voice and, once a clip was kept below the bar, the
 * hand-off's clips to name it. A job without a Generate stage shows nothing, and asks nothing.
 */
export function JobSheetGenerated({ job, variant = 'mac' }: { job: Job; variant?: SheetVariant }) {
  const generated = job.generate != null;
  const history = useJobGenerateHistory(job.id, { enabled: generated });
  const belowBar = (job.generate?.counts.belowBar ?? 0) > 0;
  const plan = useGenerateReviewPlan(job.id, { enabled: generated && belowBar });
  const view = sheetGenerated(job, { history: history.data, plan: plan.data });
  return view === null ? null : <GeneratedPanel view={view} variant={variant} />;
}
