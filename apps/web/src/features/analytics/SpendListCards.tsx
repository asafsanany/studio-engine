import type { AnalyticsClaudeUse, AnalyticsSpendList } from '@studio/shared';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import { AnalyticsCard } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { ANALYTICS_CARDS } from './analytics-copy';
import {
  creditsSummary,
  dayMonth,
  type ExtraKind,
  type FoldView,
  planSummary,
  type SpendListView,
  type SpendRowView,
  shareText,
  spendListView,
  usdText,
} from './budgets-view';
import { CHART_BLUE, CHART_ORANGE } from './charts/chart-colors';

// The two "what used it" cards of Claude use: what the API credits paid for (the app's tags, then
// its jobs) and what used the plan this week (the sessions' tags). They are one card, `SpendCard`,
// with the same columns (the name, a bar, the dollars, the share of the list and the slice of the
// budget it took); only the data, the words and the colour (blue for the credits, orange for the
// plan) differ. Ranked by spend, biggest first. What is small is folded into one "N smaller tags"
// row that opens, so the big ones show first.

const ROW_GRID =
  'grid grid-cols-[minmax(64px,120px)_minmax(24px,1fr)_56px_40px_104px] items-center gap-2 min-h-7';

/** One row: the name (`dir="auto"`, so a Hebrew name reads right to left), a bar, the dollars, the share of the list and its slice of the budget. */
function SpendRow({ row, color }: { row: SpendRowView; color: string }) {
  return (
    <div className={cn(ROW_GRID, row.nothing && 'opacity-55')}>
      <span
        dir="auto"
        className="truncate text-[13px] text-zinc-300 [unicode-bidi:plaintext]"
        title={row.label}
      >
        {row.label}
      </span>
      {row.nothing ? (
        <span className="text-xs text-muted-foreground">nothing yet</span>
      ) : (
        <div
          role="presentation"
          className="h-2.5 rounded-[2px]"
          style={{ width: `max(3px, ${row.barPercent}%)`, background: color }}
        />
      )}
      <span className="text-right text-[13px] tabular-nums">{row.usd}</span>
      <span className="text-right text-[13px] tabular-nums text-muted-foreground">{row.share}</span>
      <span className="truncate text-right text-xs text-muted-foreground">{row.extra}</span>
    </div>
  );
}

function Fold({ fold, color }: { fold: FoldView; color: string }) {
  return (
    <details className="group mt-1.5 border-t">
      <summary className="flex min-h-[34px] cursor-pointer list-none items-center gap-2 text-[13px] text-zinc-300 marker:content-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 flex-none transition-transform duration-150 ease-in-out group-open:rotate-90"
        />
        <span className="font-medium whitespace-nowrap">{fold.title}</span>
        <span className="truncate text-xs text-muted-foreground">{fold.preview}</span>
      </summary>
      <div className="pt-1 pb-1.5">
        {fold.rows.map((row) => (
          <SpendRow key={row.label} row={row} color={color} />
        ))}
      </div>
    </details>
  );
}

function GroupLabel({ children }: { children: string }) {
  return <span className="mt-1 mb-0.5 text-xs text-muted-foreground">{children}</span>;
}

function List({ view, color }: { view: SpendListView; color: string }) {
  return (
    <>
      {view.rows.map((row) => (
        <SpendRow key={row.label} row={row} color={color} />
      ))}
      {view.fold !== null && <Fold fold={view.fold} color={color} />}
    </>
  );
}

function Nothing({ children }: { children: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

/** One group of a card: its small heading and the list under it. */
interface SpendGroup {
  label: string;
  list: AnalyticsSpendList;
  /** What a row is called in "3 smaller tags"; default "tag". */
  noun?: string;
}

/**
 * The card both lists are. `extra` says what the last column is a slice of (the credits, the
 * limit); `nothing` is what it says while nothing has been used; `summary` is the line under the
 * rows. Groups with no rows are left out, so the plan's one group and the credits' two share this.
 */
function SpendCard({
  title,
  subtitle,
  className,
  color,
  extra,
  groups,
  nothing,
  summary,
}: {
  title: string;
  subtitle: string;
  className: string;
  color: string;
  extra: ExtraKind;
  groups: readonly SpendGroup[];
  nothing: string;
  summary: string | null;
}) {
  const views = groups.map((group) => ({
    label: group.label,
    view: spendListView(group.list, { noun: group.noun, extra }),
  }));
  return (
    <AnalyticsCard title={title} subtitle={subtitle} className={className}>
      {views[0]?.view.empty !== false ? (
        <Nothing>{nothing}</Nothing>
      ) : (
        <div className="flex flex-col">
          {views.map(({ label, view }) =>
            view.rows.length > 0 || view.fold !== null ? (
              <Fragment key={label}>
                <GroupLabel>{label}</GroupLabel>
                <List view={view} color={color} />
              </Fragment>
            ) : null,
          )}
          {summary !== null && <p className="mt-2.5 text-xs text-muted-foreground">{summary}</p>}
        </div>
      )}
    </AnalyticsCard>
  );
}

/** "What the API credits paid for": the app's tags, biggest first, then the jobs that cost most. */
export function CreditsPaidForCard({ credits }: { credits: AnalyticsClaudeUse['credits'] }) {
  const slice = `the last column is its slice of the ${usdText(credits.budgetUsd)}`;
  return (
    <SpendCard
      title={ANALYTICS_CARDS.creditsPaidFor.title}
      subtitle={`The app’s runs since ${dayMonth(credits.since)}, biggest first`}
      className={ANALYTICS_LAYOUT.creditsPaidFor}
      color={CHART_BLUE}
      extra="credits"
      groups={[
        { label: `By tag · ${slice}`, list: credits.tags },
        { label: 'By job', list: credits.jobs, noun: 'job' },
      ]}
      nothing="Nothing has been spent from the credits yet."
      summary={creditsSummary(credits.tags)}
    />
  );
}

/** "What used the plan this week": the sessions' tags by API value, each with its slice of the limit. */
export function PlanUsageCard({ plan }: { plan: AnalyticsClaudeUse['plan'] }) {
  return (
    <SpendCard
      title={ANALYTICS_CARDS.planUsage.title}
      subtitle={ANALYTICS_CARDS.planUsage.subtitle}
      className={ANALYTICS_LAYOUT.planUsage}
      color={CHART_ORANGE}
      extra="limit"
      groups={[
        {
          label:
            plan.week === null
              ? 'By tag'
              : `By tag · the last column is its slice of the ${shareText(plan.week.utilization)}`,
          list: plan.tags,
        },
      ]}
      nothing="No session use has been logged in this window."
      summary={planSummary(plan)}
    />
  );
}
