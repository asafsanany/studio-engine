import { describe, expect, it } from 'vitest';
import { budgetsChartView } from './budgets-chart-view';
import { appLine, budgetsAnswer } from './budgets-test-data';

// The clock of the test data is Saturday 24 October 2026, noon: now is 23.5 days into October, the
// count began on 23 Oct (x 22) and the plan's week began on 17 Oct at 21:00 (16.875 days in).

describe('budgetsChartView (month)', () => {
  const { credits, plan } = budgetsAnswer().claudeUse;
  const view = budgetsChartView(credits, plan);

  it('names the days of the month under the chart: day 1 and every seventh after it', () => {
    expect(view.xTicks.map((tick) => tick.label)).toEqual([
      'Oct 1',
      'Oct 8',
      'Oct 15',
      'Oct 22',
      'Oct 29',
    ]);
    expect(view.xTicks.map((tick) => tick.x)).toEqual([0, 7, 14, 21, 28]);
    // The whole month: day 1 at the left edge, the last day at the right.
    expect(view.xDomain).toEqual([0, 31]);
  });

  it('draws 0%, 50% and 100% as grid lines, with room above the 100% line', () => {
    expect(view.yTicks).toEqual([0, 0.5, 1]);
    expect(view.yMax).toBe(1.25);
  });

  it('has a row for what the app spent that starts at 0% and ends at now', () => {
    const spent = view.rows.filter((row) => row.credits !== null);
    expect(spent.map((row) => row.x)).toEqual([22, 23, 23.5]);
    expect(spent[0]?.credits).toBe(0);
    expect(spent.at(-1)?.credits).toBeCloseTo(credits.usedShare, 5);
    expect(spent.at(-1)?.creditsUsd).toBeCloseTo(credits.spentUsd, 5);
    expect(view.nowX).toBe(credits.nowX);
    expect(view.credits.end.x).toBe(credits.nowX);
    expect(view.credits.end.label).toBe('$52 · 26%');
  });

  it('says in each row which day it is: the end of a day, the start of the count, now', () => {
    const titles = Object.fromEntries(view.rows.map((row) => [row.x, row.title]));
    expect(titles[22]).toBe('Start of Oct 23');
    expect(titles[23]).toBe('Oct 23, end of day');
    expect(titles[23.5]).toBe('Oct 24, so far');
  });

  it('draws the plan’s weekly limit as one line that climbs from 0% at the start of its week', () => {
    expect(view.runs).toBe(1);
    const used = view.rows.filter((row) => row.plan !== null);
    // The week began on 17 Oct at 21:00, so its 0 is on the end of 17 Oct; the reading is now's.
    expect(used.map((row) => row.x)).toEqual([17, 23.5]);
    expect(used.map((row) => row.plan)).toEqual([0, 0.96]);
    expect(used.every((row) => row.run === 0)).toBe(true);
    expect(view.plan.end).toMatchObject({ x: 23.5, y: 0.96, label: '96% of limit' });
  });

  it('puts the label of the higher end above its dot', () => {
    // The 96% is far above the 26% of the credits, so each label sits above its own dot.
    expect(view.plan.end?.placement).toBe('above');
    expect(view.credits.end.placement).toBe('above');
  });

  it('puts the label of the lower of two ends close together under its dot', () => {
    const alike = budgetsChartView(credits, { ...plan, series: [[{ x: 20, use: 0.24 }]] });
    // The plan's end is the lower one: its label goes under it; the credits' stays above.
    expect(alike.credits.end.placement).toBe('above');
    expect(alike.plan.end?.placement).toBe('below');
  });

  it('puts the credits’ label above on a tie, and the plan’s under', () => {
    const tied = budgetsChartView(credits, {
      ...plan,
      series: [[{ x: credits.nowX, use: credits.usedShare }]],
    });
    expect(tied.credits.end.y).toBe(tied.plan.end?.y);
    expect(tied.credits.end.placement).toBe('above');
    expect(tied.plan.end?.placement).toBe('below');
  });

  it('puts a lower label well above when there is no room under its dot', () => {
    const low = budgetsChartView(
      { ...credits, usedShare: 0.04, spentUsd: 8 },
      { ...plan, series: [[{ x: 20, use: 0.02 }]] },
    );
    expect(low.plan.end?.placement).toBe('high');
    expect(low.credits.end.placement).toBe('above');
  });

  it('draws no plan line, and no plan label, with no reading this month', () => {
    const none = budgetsChartView(credits, budgetsAnswer({ limits: [] }).claudeUse.plan);
    expect(none.runs).toBe(0);
    expect(none.rows.every((row) => row.plan === null)).toBe(true);
    expect(none.plan.end).toBeNull();
    expect(none.credits.end.placement).toBe('above');
  });

  it('draws a line for each week of the plan, and the later reading wins a day two weeks share', () => {
    const two = budgetsChartView(credits, {
      ...plan,
      series: [
        [
          { x: 3, use: 0 },
          { x: 9.4, use: 0.6 },
        ],
        [
          { x: 9.8, use: 0 },
          { x: 16, use: 0.4 },
        ],
      ],
    });
    expect(two.runs).toBe(2);
    // Both of those readings are on 10 Oct, the row of x 10: the second week's is the one kept.
    const row = two.rows.find((r) => r.x === 10);
    expect(row).toMatchObject({ plan: 0, run: 1 });
    expect(two.rows.filter((r) => r.run === 0).map((r) => r.x)).toEqual([3]);
  });

  it('makes room above 100% for a plan that went over', () => {
    const over = budgetsChartView(credits, { ...plan, series: [[{ x: 20, use: 1.4 }]] });
    expect(over.yMax).toBeCloseTo(1.54, 5);
    expect(over.plan.end?.y).toBe(1.4);
  });

  it('draws the pace as a dashed line from now, cut where it leaves the chart', () => {
    expect(view.pace).not.toBeNull();
    expect(view.pace?.from).toEqual({ x: credits.nowX, y: credits.usedShare });
    // It reaches the top of the chart before the month ends.
    expect(view.pace?.to.y).toBeCloseTo(view.yMax, 5);
    expect(view.pace?.to.x).toBeLessThan(31);
  });

  it('marks the day it runs out where the pace crosses the 100% line', () => {
    expect(view.runOut?.label).toBe('empty ≈ 28 Oct');
    expect(view.runOut?.y).toBe(1);
    expect(view.runOut?.x).toBeGreaterThan(credits.nowX);
    expect(view.runOut?.x).toBeLessThan(31);
  });

  it('says what solid, dashed and orange mean, with the pace since the switch', () => {
    expect(view.footnote).toBe(
      'Blue: solid = used, dashed = the pace since 23 Oct, $35 a day. Orange is the plan’s weekly limit; it starts again every week.',
    );
  });

  it('runs the pace to the end of the month, with no mark, when the credits last', () => {
    const slow = budgetsAnswer({ usage: [appLine('edit', 4, 6)] }).claudeUse;
    const lasts = budgetsChartView(slow.credits, slow.plan);
    expect(lasts.runOut).toBeNull();
    expect(lasts.pace?.to.x).toBe(31);
    expect(lasts.pace?.to.y).toBeLessThan(lasts.yMax);
  });

  it('draws no pace and no mark with nothing spent, and says so', () => {
    const empty = budgetsAnswer({ usage: [] }).claudeUse;
    const idle = budgetsChartView(empty.credits, empty.plan);
    expect(idle.pace).toBeNull();
    expect(idle.runOut).toBeNull();
    expect(idle.footnote).toBe(
      'Nothing spent from the credits yet this month. Orange is the plan’s weekly limit; it starts again every week.',
    );
    expect(idle.credits.end.label).toBe('$0.00 · 0%');
  });

  it('draws no pace once the credits are used up', () => {
    const used = budgetsChartView({ ...credits, status: 'used-up', spentUsd: 230 }, plan);
    expect(used.pace).toBeNull();
    expect(used.runOut).toBeNull();
  });

  it('makes room above 100% for a month that went over', () => {
    const over = budgetsChartView(
      {
        ...credits,
        status: 'used-up',
        spentUsd: 400,
        usedShare: 2,
        series: [
          { x: 22, usd: 0 },
          { x: 23.5, usd: 400 },
        ],
      },
      plan,
    );
    expect(over.yMax).toBeCloseTo(2.2, 5);
    expect(over.credits.end.y).toBe(2);
  });
});

describe('budgetsChartView (week)', () => {
  const { credits, plan } = budgetsAnswer().claudeUse;
  const view = budgetsChartView(credits, plan, 'week');

  it('zooms in on the last 7 days: today and the 6 before it, up to now', () => {
    expect(view.xDomain).toEqual([17, 23.5]);
    expect(view.xTicks.map((tick) => tick.label)).toEqual([
      'Oct 18',
      'Oct 19',
      'Oct 20',
      'Oct 21',
      'Oct 22',
      'Oct 23',
      'Oct 24',
    ]);
    expect(view.xTicks.map((tick) => tick.x)).toEqual([17, 18, 19, 20, 21, 22, 23]);
  });

  it('keeps only the rows of those days, and still ends on now', () => {
    expect(view.rows.map((row) => row.x)).toEqual([17, 22, 23, 23.5]);
    expect(view.rows.at(-1)?.credits).toBeCloseTo(credits.usedShare, 5);
    expect(view.credits.end.label).toBe('$52 · 26%');
    expect(view.plan.end?.label).toBe('96% of limit');
  });

  it('draws no now line and no pace: now is the chart’s right edge', () => {
    expect(view.nowX).toBeNull();
    expect(view.pace).toBeNull();
    expect(view.runOut).toBeNull();
  });

  it('keeps the month’s scale, so 100% is where it is in the month chart', () => {
    expect(view.yMax).toBe(budgetsChartView(credits, plan).yMax);
    expect(view.yTicks).toEqual([0, 0.5, 1]);
  });

  it('says what blue and orange are, and when the credits run out at that pace', () => {
    expect(view.footnote).toBe(
      'Blue: the share of the month’s credits used, $35 a day since 23 Oct. At the pace the credits run out about 28 Oct. Orange is the plan’s weekly limit; it starts again every week.',
    );
  });

  it('says only that nothing is spent with nothing spent', () => {
    const empty = budgetsAnswer({ usage: [] }).claudeUse;
    expect(budgetsChartView(empty.credits, empty.plan, 'week').footnote).toBe(
      'Nothing spent from the credits yet this month. Orange is the plan’s weekly limit; it starts again every week.',
    );
  });

  it('has no plan end when the newest reading is older than the 7 days', () => {
    const stale = budgetsChartView(credits, { ...plan, series: [[{ x: 3, use: 0.5 }]] }, 'week');
    expect(stale.plan.end).toBeNull();
    expect(stale.runs).toBe(0);
  });

  it('starts at the first of the month early in the month', () => {
    const early = budgetsChartView(
      {
        ...credits,
        nowX: 2.5,
        series: [
          { x: 0, usd: 0 },
          { x: 1, usd: 1 },
          { x: 2.5, usd: 3 },
        ],
      },
      { ...plan, series: [] },
      'week',
    );
    expect(early.xDomain).toEqual([0, 2.5]);
    expect(early.rows.map((row) => row.x)).toEqual([0, 1, 2.5]);
  });
});
