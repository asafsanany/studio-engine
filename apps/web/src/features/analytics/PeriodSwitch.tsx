import { ANALYTICS_PERIODS, type AnalyticsPeriod } from '@studio/shared';

/** The two periods, in the order the switch shows them: Week, then Month. */
const LABELS: Record<AnalyticsPeriod, string> = { week: 'Week', month: 'Month' };

/**
 * "Week" | "Month": the segmented control at the right of the Analytics title, in the look of the
 * Money ledger's "Every job" | "By client" (a muted track, the chosen one raised). Plain
 * pressed-buttons, since it switches how the page's numbers are counted and has no panels. A view
 * control, not an action: it changes what the page shows and nothing else. A grey keyboard-only
 * focus line; a click leaves no ring.
 */
export function PeriodSwitch({
  period,
  onChange,
}: {
  /** The period the page is showing (the address says it). */
  period: AnalyticsPeriod;
  onChange: (period: AnalyticsPeriod) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named group of two buttons
    <div
      role="group"
      aria-label="Period"
      className="inline-flex flex-none rounded-lg bg-muted p-[3px]"
    >
      {ANALYTICS_PERIODS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={period === value}
          onClick={() => onChange(value)}
          className="h-[29px] rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-in-out outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground/30 aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
        >
          {LABELS[value]}
        </button>
      ))}
    </div>
  );
}
