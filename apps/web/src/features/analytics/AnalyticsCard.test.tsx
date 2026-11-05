import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAnalyticsResponse } from '@/data/test-utils';
import { AnalyticsCard, AnalyticsTileCard, NoDataYet } from './AnalyticsCard';
import { ApprovedFirstTimeCard } from './ApprovedFirstTimeCard';
import { ANALYTICS_CARDS } from './analytics-copy';
import { BusiestWeekCard } from './BusiestWeekCard';
import { DeliveredPerDayCard } from './DeliveredPerDayCard';
import { FootagePerWeekCard } from './FootagePerWeekCard';
import { NoteTopicsCard } from './NoteTopicsCard';
import { RerunsPerApprovedCard } from './RerunsPerApprovedCard';
import { TypicalJobCard } from './TypicalJobCard';

describe('<AnalyticsCard>', () => {
  const markup = renderToStaticMarkup(
    <AnalyticsCard title="Footage edited per week" subtitle="Hours of raw footage" className="h-10">
      <p>body</p>
    </AnalyticsCard>,
  );

  it('is a section named by its title, with a border, a 12 px radius and 20 px of padding', () => {
    expect(markup).toMatch(/^<section aria-label="Footage edited per week"/);
    expect(markup).toContain('rounded-[12px]');
    expect(markup).toContain('border');
    expect(markup).toContain('p-5');
  });

  it('says its title in medium weight and its subtitle muted, 13 px', () => {
    expect(markup).toMatch(/<h3 class="font-medium">Footage edited per week<\/h3>/);
    expect(markup).toMatch(
      /<p class="text-\[13px\] text-muted-foreground">Hours of raw footage<\/p>/,
    );
  });

  it('puts its content under the title and takes the size it is given', () => {
    expect(markup.indexOf('Hours of raw footage')).toBeLessThan(markup.indexOf('<p>body</p>'));
    expect(markup).toContain('h-10');
  });

  it('keeps what does not fit inside the card', () => {
    expect(markup).toContain('overflow-hidden');
    expect(markup).toContain('min-w-0');
  });
});

describe('<AnalyticsTileCard>', () => {
  const markup = renderToStaticMarkup(
    <AnalyticsTileCard title="Clients" subtitle="With a job finished, last 30 days">
      <p>body</p>
    </AnalyticsTileCard>,
  );

  it('is a section named by its title, with 16 px of padding, and cuts a long subtitle short', () => {
    expect(markup).toMatch(/^<section aria-label="Clients"/);
    expect(markup).toContain('p-4');
    expect(markup).toContain('rounded-[12px]');
    expect(markup).toMatch(/<p class="truncate text-\[13px\] text-muted-foreground">/);
  });
});

describe('<NoDataYet>', () => {
  it('says "No data yet", muted, and nothing else', () => {
    const markup = renderToStaticMarkup(<NoDataYet />);
    expect(markup).toContain('>No data yet</p>');
    expect(markup).toContain('text-muted-foreground');
    expect(markup).not.toContain('<button');
  });
});

// The stubs of AN0: each card is its shell and "No data yet" until its own work item draws it.
describe('the card stubs', () => {
  const answer = makeAnalyticsResponse();
  const cases = [
    ['DeliveredPerDayCard', () => <DeliveredPerDayCard days={answer.jobs.deliveredPerDay} />],
    ['FootagePerWeekCard', () => <FootagePerWeekCard weeks={answer.jobs.footage} />],
    ['TypicalJobCard', () => <TypicalJobCard typicalJob={answer.typicalJob} />],
    [
      'RerunsPerApprovedCard',
      () => <RerunsPerApprovedCard weeks={answer.reviews.approvedFirstTime} />,
    ],
    [
      'ApprovedFirstTimeCard',
      () => <ApprovedFirstTimeCard weeks={answer.reviews.approvedFirstTime} />,
    ],
    ['NoteTopicsCard', () => <NoteTopicsCard reviews={answer.reviews} />],
    ['BusiestWeekCard', () => <BusiestWeekCard weeks={answer.claudeUse.busiest} />],
  ] as const;

  it.each(cases)('%s shows its title, its subtitle and its empty line', (_name, render) => {
    const markup = renderToStaticMarkup(render());
    const copy = Object.values(ANALYTICS_CARDS).find((card) =>
      markup.includes(`aria-label="${card.title}"`),
    );
    expect(copy).toBeDefined();
    expect(markup).toContain(`>${copy?.title}</h3>`);
    expect(markup).toContain(`>${copy?.subtitle}</p>`);
    // Each card says its own empty line: "No review notes yet" with no note sent (AN3), "Not
    // enough finished jobs yet" while fewer than two jobs have finished (AN2), else "No data yet".
    expect(markup).toMatch(/No data yet|No review notes yet|Not enough finished jobs yet/);
  });

  it('are the seven data cards of the board, each once', () => {
    const titles = cases.map(([, render]) => {
      const markup = renderToStaticMarkup(render());
      return markup.match(/aria-label="([^"]+)"/)?.[1];
    });
    expect(new Set(titles).size).toBe(7);
    const budgets = ['API credits', 'Max plan, this week', 'What the API credits paid for'];
    expect(titles).toEqual(
      Object.values(ANALYTICS_CARDS)
        .map((card) => card.title)
        .filter(
          (title) =>
            !budgets.includes(title) &&
            title !== 'What used the plan this week' &&
            title !== 'API credits and plan through the month',
        ),
    );
  });

  it('read nothing but their section and have nothing to click', () => {
    for (const [, render] of cases) {
      const markup = renderToStaticMarkup(render());
      expect(markup).not.toContain('<button');
      expect(markup).not.toContain('<a ');
    }
  });
});
