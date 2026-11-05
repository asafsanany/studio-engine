import type { AnalyticsJobs, AnalyticsPeriod } from '@studio/shared';
import { AnalyticsCard, NoDataYet } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { cardCopy } from './analytics-copy';
import { HoverTip } from './charts/HoverTip';
import { ValueBarChart } from './charts/ValueBarChart';
import {
  CALENDAR_WEEKDAYS,
  type CalendarCell,
  DELIVERY_LEGEND_COLORS,
  DELIVERY_LEVEL_COLORS,
  deliveryBars,
  deliveryCalendar,
} from './delivery-calendar-view';

/** The weekday labels' column. */
const LABEL_WIDTH = '32px';

function Cell({ cell }: { cell: CalendarCell }) {
  const day = (
    <span
      className="h-full w-full rounded-[3px]"
      style={cell.level === null ? undefined : { background: DELIVERY_LEVEL_COLORS[cell.level] }}
    />
  );
  return cell.title === '' ? day : <HoverTip text={cell.title}>{day}</HoverTip>;
}

const jobs = (count: number) => `${count} ${count === 1 ? 'job' : 'jobs'}`;

/**
 * "Jobs delivered per day": the last 13 weeks as a calendar, a column per week and a row per
 * weekday, a deeper blue for more jobs, with the 0 … 3+ legend under it; hovering a day says its
 * date and its jobs. A day with no data (not come yet, or before the first record) is left empty.
 * The calendar is as wide and as tall as its card. In the week period it is the last 14 days as a
 * bar each, with the same hover. With nothing recorded at all the card says "No data yet".
 */
export function DeliveredPerDayCard({
  days,
  period = 'month',
}: {
  days: AnalyticsJobs['deliveredPerDay'];
  period?: AnalyticsPeriod;
}) {
  const calendar = deliveryCalendar(days);
  const bars = deliveryBars(days);
  return (
    <AnalyticsCard
      {...cardCopy(period).deliveredPerDay}
      className={ANALYTICS_LAYOUT.deliveredPerDay}
    >
      {!calendar.hasData ? (
        <NoDataYet />
      ) : period === 'week' ? (
        <div className="flex h-full min-h-0 flex-col">
          <ValueBarChart
            rows={bars.rows}
            labels={bars.labels}
            scale={bars.scale}
            formatTick={String}
            formatValue={jobs}
            seriesLabel="Jobs delivered"
            ariaLabel="Jobs delivered per day, for the last 14 days"
          />
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-2.5">
          <div
            role="img"
            aria-label={calendar.summary}
            className="grid min-h-[150px] flex-1 gap-1"
            style={{
              gridTemplateColumns: `${LABEL_WIDTH} repeat(${calendar.weeks.length}, minmax(0, 1fr))`,
              gridTemplateRows: 'auto repeat(7, minmax(0, 1fr))',
            }}
          >
            <span aria-hidden="true" />
            {calendar.monthLabels.map((label, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is its place in the row
                key={i}
                className="overflow-visible text-xs whitespace-nowrap text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {CALENDAR_WEEKDAYS.flatMap((weekday, row) => [
              <span key={weekday} className="truncate text-xs text-muted-foreground">
                {weekday}
              </span>,
              ...calendar.weeks.map((week) => {
                const cell = week[row];
                return cell === undefined ? null : <Cell key={cell.date} cell={cell} />;
              }),
            ])}
          </div>
          <div
            aria-hidden="true"
            className="flex flex-none items-center gap-1.5 text-xs text-muted-foreground"
          >
            0
            {DELIVERY_LEGEND_COLORS.map((color) => (
              <span key={color} className="size-3 rounded-[3px]" style={{ background: color }} />
            ))}
            3+
          </div>
        </div>
      )}
    </AnalyticsCard>
  );
}
