import { ANALYTICS_TILES, type AnalyticsResponse } from '@studio/shared';
import type { ReactNode } from 'react';
import { ANALYTICS_LAYOUT, CardPlaceholder } from './AnalyticsStates';
import { ApprovedFirstTimeCard } from './ApprovedFirstTimeCard';
import { ANALYTICS_SECTIONS, SERVICES_SECTION } from './analytics-copy';
import { ApiCreditsCard, MaxPlanCard } from './BudgetGaugeCards';
import { BusiestWeekCard } from './BusiestWeekCard';
import { CreditsThroughMonthCard } from './CreditsThroughMonthCard';
import { DeliveredPerDayCard } from './DeliveredPerDayCard';
import { FootagePerWeekCard } from './FootagePerWeekCard';
import { JobsTiles } from './JobsTiles';
import { NoteTopicsCard } from './NoteTopicsCard';
import { RerunsPerApprovedCard } from './RerunsPerApprovedCard';
import { ServicesCard } from './ServicesCard';
import { CreditsPaidForCard, PlanUsageCard } from './SpendListCards';
import { TypicalJobCard } from './TypicalJobCard';

/** A section's heading with the one line under it that says what the section is for. */
function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-0.5 pt-2">
      <h2 className="text-base leading-[1.43] font-semibold">{title}</h2>
      <p className="text-[13px] leading-[1.43] text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/**
 * A card's place on the page: the card itself once there is an answer, else the placeholder of the
 * same size (grey when `skeleton`, an empty space before that).
 */
function Slot({
  size,
  skeleton,
  children,
}: {
  size: string;
  skeleton: boolean;
  children: ReactNode;
}) {
  return children ? children : <CardPlaceholder visible={skeleton} className={size} />;
}

/**
 * Everything under the page title: the Jobs, Reviews and Claude use sections with their cards, as
 * the design lays them out (five tiles; then rows of two; Claude use: two gauges, two lists, two
 * charts; one column below 1000 px). Read-only. `data` is `undefined` until the first answer; the cards are then
 * placeholders of their final size, grey only once `skeleton` says the wait is real. The cards say
 * their words for the period the answer is for (`data.period`), so while the other period loads the
 * page that is on screen stays whole.
 */
export function AnalyticsBody({
  data,
  skeleton,
}: {
  data: AnalyticsResponse | undefined;
  skeleton: boolean;
}) {
  const slot = (size: string, card: ReactNode, key?: string) => (
    <Slot key={key} size={size} skeleton={skeleton}>
      {card}
    </Slot>
  );
  return (
    <>
      {data === undefined && skeleton && (
        <span role="status" className="sr-only">
          Loading the analytics…
        </span>
      )}

      <SectionHeading {...ANALYTICS_SECTIONS.jobs} />
      <div className={ANALYTICS_LAYOUT.tilesGrid}>
        {data
          ? slot(ANALYTICS_LAYOUT.tile, <JobsTiles tiles={data.jobs.tiles} period={data.period} />)
          : ANALYTICS_TILES.map((tile) => slot(ANALYTICS_LAYOUT.tile, null, tile.key))}
      </div>
      <div className={ANALYTICS_LAYOUT.cardsGrid}>
        {slot(
          ANALYTICS_LAYOUT.deliveredPerDay,
          data && <DeliveredPerDayCard days={data.jobs.deliveredPerDay} period={data.period} />,
        )}
        {slot(
          ANALYTICS_LAYOUT.footagePerWeek,
          data && <FootagePerWeekCard weeks={data.jobs.footage} period={data.period} />,
        )}
      </div>
      <div className={ANALYTICS_LAYOUT.cardsGrid}>
        {slot(
          ANALYTICS_LAYOUT.typicalJob,
          data && <TypicalJobCard typicalJob={data.typicalJob} period={data.period} />,
        )}
      </div>

      <SectionHeading {...ANALYTICS_SECTIONS.reviews} />
      <div className={ANALYTICS_LAYOUT.cardsGrid}>
        {slot(
          ANALYTICS_LAYOUT.approvedFirstTime,
          data && (
            <ApprovedFirstTimeCard weeks={data.reviews.approvedFirstTime} period={data.period} />
          ),
        )}
        {slot(ANALYTICS_LAYOUT.noteTopics, data && <NoteTopicsCard reviews={data.reviews} />)}
      </div>

      <div className={ANALYTICS_LAYOUT.cardsGrid}>
        {slot(
          ANALYTICS_LAYOUT.rerunsPerApproved,
          data && (
            <RerunsPerApprovedCard weeks={data.reviews.approvedFirstTime} period={data.period} />
          ),
        )}
      </div>

      <SectionHeading {...ANALYTICS_SECTIONS.claudeUse} />
      <div className={ANALYTICS_LAYOUT.cardsGrid}>
        {slot(
          ANALYTICS_LAYOUT.apiCredits,
          data && <ApiCreditsCard credits={data.claudeUse.credits} />,
        )}
        {slot(
          ANALYTICS_LAYOUT.maxPlan,
          data && (
            <MaxPlanCard
              plan={data.claudeUse.plan}
              generatedAt={data.generatedAt}
              timeZone={data.timeZone}
            />
          ),
        )}
      </div>
      <div className={ANALYTICS_LAYOUT.listsGrid}>
        {slot(
          ANALYTICS_LAYOUT.creditsPaidFor,
          data && <CreditsPaidForCard credits={data.claudeUse.credits} />,
        )}
        {slot(ANALYTICS_LAYOUT.planUsage, data && <PlanUsageCard plan={data.claudeUse.plan} />)}
      </div>
      <div className={ANALYTICS_LAYOUT.cardsGrid}>
        {slot(
          ANALYTICS_LAYOUT.creditsThroughMonth,
          data && (
            <CreditsThroughMonthCard
              credits={data.claudeUse.credits}
              plan={data.claudeUse.plan}
              period={data.period}
            />
          ),
        )}
        {slot(
          ANALYTICS_LAYOUT.busiestWeek,
          data && (
            <BusiestWeekCard
              weeks={data.claudeUse.busiest}
              budgetUsd={data.claudeUse.credits.budgetUsd}
              period={data.period}
            />
          ),
        )}
      </div>

      {data?.services && (
        <>
          <SectionHeading {...SERVICES_SECTION} />
          <div className={ANALYTICS_LAYOUT.cardsGrid}>
            {slot(
              ANALYTICS_LAYOUT.services,
              <ServicesCard services={data.services} period={data.period} />,
            )}
          </div>
        </>
      )}
    </>
  );
}
