import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiCreditsCard, MaxPlanCard } from './BudgetGaugeCards';
import { budgetsAnswer, ZONE } from './budgets-test-data';
import { CreditsThroughMonthCard } from './CreditsThroughMonthCard';
import { CreditsPaidForCard, PlanUsageCard } from './SpendListCards';

// The cards of the two budgets, drawn from an answer with numbers in it (budgets-test-data.ts).

const answer = budgetsAnswer();
const { credits, plan } = answer.claudeUse;
const emptyAnswer = budgetsAnswer({ usage: [], limits: [] });

const creditsCard = renderToStaticMarkup(<ApiCreditsCard credits={credits} />);
const planCard = renderToStaticMarkup(
  <MaxPlanCard plan={plan} generatedAt={answer.generatedAt} timeZone={ZONE} />,
);

describe('<ApiCreditsCard>', () => {
  it('is a card called "API credits", with the month in its subtitle and half the row', () => {
    expect(creditsCard).toMatch(/^<section aria-label="API credits"/);
    expect(creditsCard).toContain('>API credits</h3>');
    expect(creditsCard).toContain('The app’s own runs: edits, re-edits, renders · October');
    expect(creditsCard).toContain('min-[1000px]:col-span-3');
  });

  it('draws a gauge of the share used with "$52 of $200" and the month’s tick', () => {
    expect(creditsCard).toMatch(/<svg[^>]*role="img"[^>]*aria-label="API credits used: 26%"/);
    expect(creditsCard).toContain('>26%</text>');
    expect(creditsCard).toContain('>$52 of $200</text>');
    expect(creditsCard).toContain('stroke-dasharray="26.1 100"');
    expect(creditsCard).toContain('76% of the month gone');
  });

  it('says Left, Spending and At this pace, and warns in the chip and the figure', () => {
    expect(creditsCard).toContain('>Spending fast</span>');
    expect(creditsCard).toContain('data-tone="warn"');
    expect(creditsCard).toContain('about 13 more first passes at $11.50 each');
    expect(creditsCard).toContain('>$35 a day</span>');
    expect(creditsCard).toContain('since 23 Oct, when the app moved to the API key');
    expect(creditsCard).toContain('runs out about 28 Oct');
  });

  it('has no chip with nothing spent, and an empty gauge', () => {
    const markup = renderToStaticMarkup(<ApiCreditsCard credits={emptyAnswer.claudeUse.credits} />);
    expect(markup).not.toContain('data-tone');
    expect(markup).toContain('>0%</text>');
    expect(markup).not.toContain('stroke-dasharray');
  });

  it('is read-only', () => {
    expect(creditsCard).not.toContain('<button');
    expect(creditsCard).not.toContain('<a ');
  });
});

describe('<MaxPlanCard>', () => {
  it('is a card called "Max plan, this week" that says when the window resets', () => {
    expect(planCard).toMatch(/^<section aria-label="Max plan, this week"/);
    expect(planCard).toContain('Your Claude Code sessions · resets Sat 21:00');
  });

  it('draws the weekly limit with "96%", "of the weekly limit" and the week’s tick', () => {
    expect(planCard).toMatch(/aria-label="Weekly plan limit used: 96%"/);
    expect(planCard).toContain('>96%</text>');
    expect(planCard).toContain('>of the weekly limit</text>');
    expect(planCard).toContain('95% of the week gone');
  });

  it('says "Near the limit", the five-hour window, the API value covered and the last reading', () => {
    expect(planCard).toContain('>Near the limit</span>');
    expect(planCard).toContain('Five-hour window');
    expect(planCard).toMatch(/aria-label="Five-hour window used: 3%"/);
    expect(planCard).toContain('>$1,036 of API value</span>');
    expect(planCard).toContain('for a $200-a-month plan, about $46 a week');
    expect(planCard).toContain('>24 Oct, 11:50</span>');
    expect(planCard).toContain('10 minutes ago');
  });

  it('has an empty gauge that says so, with no reading for this week', () => {
    const markup = renderToStaticMarkup(
      <MaxPlanCard
        plan={emptyAnswer.claudeUse.plan}
        generatedAt={emptyAnswer.generatedAt}
        timeZone={ZONE}
      />,
    );
    expect(markup).toContain('>–</text>');
    expect(markup).toContain('no reading for this week yet');
    expect(markup).toContain('None yet');
    expect(markup).not.toContain('data-tone');
    expect(markup).not.toContain('Five-hour window');
    expect(markup).not.toContain('stroke-dasharray');
  });
});

describe('<CreditsPaidForCard>', () => {
  const markup = renderToStaticMarkup(<CreditsPaidForCard credits={credits} />);

  it('is a card called "What the API credits paid for", dated from the switch', () => {
    expect(markup).toMatch(/^<section aria-label="What the API credits paid for"/);
    expect(markup).toContain('The app’s runs since 23 Oct, biggest first');
  });

  it('lists the tags biggest first, then the jobs', () => {
    expect(markup).toContain('By tag');
    expect(markup).toContain('By job');
    expect(markup.indexOf('>revise<')).toBeLessThan(markup.indexOf('>edit<'));
    expect(markup.indexOf('By tag')).toBeLessThan(markup.indexOf('By job'));
    expect(markup).toContain('>$39</span>');
    expect(markup).toContain('>75%</span>');
    expect(markup).toContain('≈ 20% of credits');
    expect(markup).toContain('By tag · the last column is its slice of the $200');
  });

  it('reads names by their own direction, so a Hebrew job name reads right to left', () => {
    expect(markup).toContain('יעל כהן · Demo 2');
    const names = markup.match(/<span dir="auto"[^>]*>[^<]*<\/span>/g) ?? [];
    expect(names.length).toBeGreaterThan(4);
    expect(names.some((name) => name.includes('יעל כהן'))).toBe(true);
    expect(markup).toContain('[unicode-bidi:plaintext]');
  });

  it('folds the small tags into one closed row that opens', () => {
    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('>12 smaller tags · 2.3%</span>');
    expect(markup).toContain('graphic, note-topics, fix-route, generate …');
    // The folded rows are inside it; tags with no use say so.
    const details = markup.match(/<details.*<\/details>/s)?.[0] ?? '';
    expect(details).toContain('>note-topics<');
    expect(details).toContain('nothing yet');
  });

  it('draws bars in the credits blue', () => {
    expect(markup).toContain('background:#3987e5');
  });

  it('says which tag took most of it', () => {
    expect(markup).toContain('Re-edits took 75%.');
  });

  it('says what it has not got yet, with nothing spent', () => {
    const none = renderToStaticMarkup(
      <CreditsPaidForCard credits={emptyAnswer.claudeUse.credits} />,
    );
    expect(none).toContain('Nothing has been spent from the credits yet.');
    expect(none).not.toContain('<details');
  });
});

describe('<PlanUsageCard>', () => {
  const markup = renderToStaticMarkup(<PlanUsageCard plan={plan} />);

  it('is a card called "What used the plan this week"', () => {
    expect(markup).toMatch(/^<section aria-label="What used the plan this week"/);
    expect(markup).toContain('Your sessions by tag, biggest first');
  });

  it('lists the session tags biggest first with their slice of the 96%', () => {
    expect(markup).toContain('By tag · the last column is its slice of the 96%');
    expect(markup.indexOf('>orchestration<')).toBeLessThan(markup.indexOf('>development<'));
    expect(markup).toContain('>$470</span>');
    expect(markup).toContain('≈ 44% of limit');
    expect(markup).toContain('≈ 33% of limit');
  });

  it('folds the small tags, and draws bars in the plan’s orange', () => {
    expect(markup).toContain('>2 smaller tags · &lt;0.5%</span>');
    expect(markup).toContain('personal, research');
    expect(markup).toContain('&lt; 1% of limit');
    expect(markup).toContain('background:#d95926');
  });

  it('says how the slice is worked out', () => {
    expect(markup).toContain(
      'Orchestration and development alone used about 76% of this week’s limit.',
    );
  });

  it('lists the last 7 days with no slices when the plan has no reading', () => {
    const none = renderToStaticMarkup(
      <PlanUsageCard plan={budgetsAnswer({ limits: [] }).claudeUse.plan} />,
    );
    expect(none).toContain('>By tag</span>');
    expect(none).not.toContain('of limit');
    expect(none).toContain('There is no reading of the plan for this week yet');
  });

  it('says what it has not got yet, with no sessions', () => {
    const none = renderToStaticMarkup(<PlanUsageCard plan={emptyAnswer.claudeUse.plan} />);
    expect(none).toContain('No session use has been logged in this window.');
  });
});

describe('the two lists', () => {
  const creditsList = renderToStaticMarkup(<CreditsPaidForCard credits={credits} />);
  const planList = renderToStaticMarkup(<PlanUsageCard plan={plan} />);

  // One card, two sets of data: the same columns and the same shell, only the colour differs.
  it('are drawn alike: the same row grid, and a slice of the budget in the last column', () => {
    const grid = (markup: string) => markup.match(/grid grid-cols-\[[^\]]+\]/)?.[0];
    expect(grid(creditsList)).toBeDefined();
    expect(grid(creditsList)).toBe(grid(planList));
    expect(creditsList).toContain('of credits');
    expect(planList).toContain('of limit');
    // The old last column counted runs; it is a slice of the budget now.
    expect(creditsList).not.toMatch(/\d runs?</);
  });

  it('take the colour of their budget and nothing else', () => {
    expect(creditsList).toContain('background:#3987e5');
    expect(creditsList).not.toContain('background:#d95926');
    expect(planList).toContain('background:#d95926');
    expect(planList).not.toContain('background:#3987e5');
  });
});

describe('<CreditsThroughMonthCard>', () => {
  const markup = renderToStaticMarkup(<CreditsThroughMonthCard credits={credits} plan={plan} />);

  it('is a card called "API credits and plan through the month" with half the row', () => {
    expect(markup).toMatch(/^<section aria-label="API credits and plan through the month"/);
    expect(markup).toContain('The share of each budget used so far');
    expect(markup).toContain('min-[1000px]:col-span-3');
    expect(markup).not.toContain('min-[1200px]:col-span-2');
  });

  it('has the key of the two budgets', () => {
    expect(markup).toContain('API credits');
    expect(markup).toContain('Max plan');
  });

  it('draws one chart that fills its card, named for a screen reader, and keeps the card’s height', () => {
    expect(markup.match(/data-slot="chart"/g)).toHaveLength(1);
    expect(markup).toMatch(
      /role="img" aria-label="Share of the API credits and of the plan’s weekly limit used through the month"/,
    );
    expect(markup).toContain('absolute inset-0');
    expect(markup).toContain('min-h-[400px]');
  });

  it('says what solid, dashed and orange mean under the chart', () => {
    expect(markup).toContain('Blue: solid = used, dashed = the pace since 23 Oct, $35 a day.');
    expect(markup).toContain('Orange is the plan’s weekly limit; it starts again every week.');
  });

  it('says there is nothing spent yet with nothing spent', () => {
    const none = renderToStaticMarkup(
      <CreditsThroughMonthCard
        credits={emptyAnswer.claudeUse.credits}
        plan={emptyAnswer.claudeUse.plan}
      />,
    );
    expect(none).toContain('Nothing spent from the credits yet this month.');
  });

  it('is the last 7 days in the week period, with its own title and words', () => {
    const week = renderToStaticMarkup(
      <CreditsThroughMonthCard credits={credits} plan={plan} period="week" />,
    );
    expect(week).toMatch(/^<section aria-label="API credits and plan through the week"/);
    expect(week).toContain('The share of each budget used, last 7 days');
    expect(week).toContain(
      'aria-label="Share of the API credits and of the plan’s weekly limit used, for the last 7 days"',
    );
    expect(week).toContain('Blue: the share of the month’s credits used, $35 a day since 23 Oct.');
    expect(week).not.toContain('through the month');
  });
});
