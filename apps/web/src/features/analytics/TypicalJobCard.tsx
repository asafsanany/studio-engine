import type { AnalyticsPeriod, AnalyticsTypicalJob } from '@studio/shared';
import { cn } from '@/lib/utils';
import { AnalyticsCard } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { cardCopy } from './analytics-copy';
import { HoverTip } from './charts/HoverTip';
import {
  type Change,
  type ChangeTone,
  NOT_ENOUGH_FINISHED_JOBS,
  type StepRow,
  type StripPart,
  TYPICAL_JOB_COLORS,
  type TypicalJobView,
  typicalJobView,
} from './typical-job-view';

/** The columns of the step table: the name, the bars, the typical time and the change. */
const STEP_GRID = 'grid grid-cols-[110px_minmax(0,1fr)_70px_90px] items-center gap-3';

const CHANGE_COLOR: Record<ChangeTone, string> = {
  better: 'text-[#4ADE80]',
  worse: 'text-[#F87171]',
  same: 'text-muted-foreground',
  none: 'text-muted-foreground',
};

const percent = (value: number): string => `${value.toFixed(2)}%`;

/** A line of the card with the change after it in green or red: "Whole job · 2 h 52 m (25 min faster)". */
function Headline({
  text,
  change,
  className,
}: {
  text: string;
  change: Change | null;
  className?: string;
}) {
  return (
    <p className={cn('text-[13px] text-zinc-300', className)}>
      {text}
      {change !== null && <span className={CHANGE_COLOR[change.tone]}> {change.text}</span>}
    </p>
  );
}

/** The whole job as one bar, cut into its parts; a part is at least 4 px wide, so a short one shows. */
function Strip({ parts }: { parts: readonly StripPart[] }) {
  return (
    <>
      <div aria-hidden="true" className="flex h-5 gap-0.5 overflow-hidden rounded-[6px]">
        {parts.map((part) => (
          <HoverTip key={part.key} text={`${part.label}: ${part.text}`}>
            <div
              className="flex-none"
              style={{
                width: `max(4px, calc(${percent(part.percent)} - 2px))`,
                background: part.color,
              }}
            />
          </HoverTip>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((part) => (
          <li key={part.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 flex-none rounded-[2px]"
              style={{ background: part.color }}
            />
            {part.label} {part.text}
          </li>
        ))}
      </ul>
    </>
  );
}

function StepTableRow({ row }: { row: StepRow }) {
  return (
    <div className={STEP_GRID}>
      <span className="text-[13px] text-zinc-300">{row.label}</span>
      {row.bar === null ? (
        <div aria-hidden="true" className="relative h-4 rounded-[3px] bg-white/[0.03]" />
      ) : (
        // The whole track takes the pointer, not just the bar, which can be a couple of pixels wide.
        <HoverTip
          text={`${row.label}: ${row.text}${row.change.text === '' ? '' : ` (${row.change.text})`}`}
        >
          <div aria-hidden="true" className="relative h-4 rounded-[3px] bg-white/[0.03]">
            <div
              className="absolute inset-y-0 min-w-0.5 rounded-[3px]"
              style={{
                left: percent(row.bar.left),
                width: percent(row.bar.width),
                background: row.slowest ? TYPICAL_JOB_COLORS.slowest : TYPICAL_JOB_COLORS.editor,
              }}
            />
          </div>
        </HoverTip>
      )}
      <span className="text-right text-[13px] tabular-nums">{row.text}</span>
      <span className={cn('text-right text-[13px] tabular-nums', CHANGE_COLOR[row.change.tone])}>
        {row.change.text}
      </span>
    </div>
  );
}

/** The editor's steps: a column of names, bars on a minutes axis, the typical time and the change. */
function StepTable({ view }: { view: TypicalJobView }) {
  return (
    <div className="flex flex-col gap-[7px]">
      <div className={cn(STEP_GRID, 'text-xs text-muted-foreground')}>
        <span>Step</span>
        <div aria-hidden="true" className="relative h-4">
          {view.axis.map((tick) => (
            <span
              key={tick.label}
              className="absolute -translate-x-1/2"
              style={{ left: percent(tick.left) }}
            >
              {tick.label}
            </span>
          ))}
        </div>
        <span className="text-right">Typical</span>
        <span className="text-right">vs before</span>
      </div>
      {view.rows.map((row) => (
        <StepTableRow key={row.key} row={row} />
      ))}
    </div>
  );
}

/**
 * "A typical job, step by step": the whole job as one strip (waiting to start, the editor,
 * waiting for you, render) and the editor's steps as bars, the slowest in orange, each with its
 * change against the 30 days before (in the week period, the last 7 days against the 7 before).
 * Read-only. With fewer than two finished jobs in the window there is no typical job yet, and the
 * card says so.
 */
export function TypicalJobCard({
  typicalJob,
  period = 'month',
}: {
  typicalJob: AnalyticsTypicalJob;
  period?: AnalyticsPeriod;
}) {
  const view = typicalJobView(typicalJob);
  return (
    <AnalyticsCard {...cardCopy(period).typicalJob} className={ANALYTICS_LAYOUT.typicalJob}>
      {view === null ? (
        <div className="flex h-full min-h-16 items-center justify-center">
          <p className="text-sm text-muted-foreground">{NOT_ENOUGH_FINISHED_JOBS}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <Headline {...view.whole} />
          <Strip parts={view.strip} />
          <Headline {...view.editor} className="pt-1.5" />
          <StepTable view={view} />
          {view.footer !== null && <p className="text-xs text-muted-foreground">{view.footer}</p>}
        </div>
      )}
    </AnalyticsCard>
  );
}
