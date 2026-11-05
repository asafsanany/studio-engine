import type { AnalyticsPeriod, AnalyticsServiceRow, AnalyticsServices } from '@studio/shared';
import { cn } from '@/lib/utils';
import { AnalyticsCard } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { SERVICES_CARD } from './analytics-copy';
import { costText, planLines, servicesPeriodText, servicesTotalText } from './services-view';

// The Services card: every API and subscription the app uses (CLAUDE.md › APIs and services),
// paid ones first, each with its plan from money.json, what it was used for and what it cost in the
// period. A paid one that is not connected to the Money page yet says what is missing, in amber.

const ROW_GRID =
  'grid grid-cols-1 gap-x-4 gap-y-1 py-2.5 min-[1000px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_72px] min-[1000px]:items-start';

function ServiceRow({ row }: { row: AnalyticsServiceRow }) {
  const plans = planLines(row);
  return (
    <li className={cn(ROW_GRID, 'border-t first:border-t-0')} data-service={row.id}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.name}</span>
          <span className="text-xs text-muted-foreground">
            {row.cost === 'paid' ? 'Paid' : 'Free'}
          </span>
        </div>
        <span className="text-[13px] text-muted-foreground">{row.forWhat}</span>
        {row.gap !== null && (
          <span className="text-xs text-amber-400">Not tracked in Money yet: {row.gap}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 text-[13px]">
        {plans.map((plan) => (
          <span key={plan.text} className={plan.missing ? 'text-amber-400' : 'text-zinc-300'}>
            {plan.text}
          </span>
        ))}
      </div>
      <span className="text-[13px] text-zinc-300">{row.uses ?? '—'}</span>
      <span className="text-[13px] tabular-nums min-[1000px]:text-right">{costText(row)}</span>
    </li>
  );
}

const HEADER_GRID =
  'hidden gap-x-4 pb-1 text-xs text-muted-foreground min-[1000px]:grid min-[1000px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_72px]';

/** "Services": the table of every API and subscription, for the period the page shows. */
export function ServicesCard({
  services,
  period,
}: {
  services: AnalyticsServices;
  period: AnalyticsPeriod;
}) {
  return (
    <AnalyticsCard
      title={SERVICES_CARD.title}
      subtitle={`${SERVICES_CARD.subtitle} · ${servicesPeriodText(period)}`}
      className={ANALYTICS_LAYOUT.services}
    >
      <div className={HEADER_GRID} aria-hidden="true">
        <span>Service</span>
        <span>Plan</span>
        <span>Used</span>
        <span className="text-right">Cost</span>
      </div>
      <ul className="flex flex-col">
        {services.rows.map((row) => (
          <ServiceRow key={row.id} row={row} />
        ))}
      </ul>
      {services.otherPlans.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t pt-2.5">
          <span className="text-xs text-muted-foreground">Other subscriptions</span>
          {services.otherPlans.map((plan) => (
            <div key={plan.name} className="flex justify-between gap-4 text-[13px]">
              <span className="text-zinc-300">
                {plan.name} · {plan.price}
              </span>
              <span className="tabular-nums">{costText({ cost: 'paid', ils: plan.ils })}</span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{servicesTotalText(services)}</p>
    </AnalyticsCard>
  );
}
