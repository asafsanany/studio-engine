import { describe, expect, it } from 'vitest';
import { appLine, budgetsAnswer, reading, ZONE } from './budgets-test-data';
import {
  agoText,
  creditsSummary,
  creditsView,
  dayMonth,
  planReadingIsStale,
  planSummary,
  planView,
  readingText,
  resetText,
  shareText,
  spendListView,
  usdText,
} from './budgets-view';

describe('usdText', () => {
  it.each([
    [470, '$470'],
    [39.4, '$39'],
    [10, '$10'],
    [9.5, '$9.50'],
    [3.411, '$3.41'],
    [0.06, '$0.06'],
    [0, '$0.00'],
    [1036.04, '$1,036'],
    [200, '$200'],
  ])('writes %s as %s', (value, text) => {
    expect(usdText(value)).toBe(text);
  });
});

describe('shareText', () => {
  it.each([
    [0.747, '75%'],
    [0.225, '23%'],
    [0.068, '6.8%'],
    [0.022, '2.2%'],
    [0.0049, '<0.5%'],
    [0.005, '0.5%'],
    [0, '0%'],
    [1, '100%'],
  ])('writes %s as %s', (share, text) => {
    expect(shareText(share)).toBe(text);
  });
});

describe('dayMonth', () => {
  it('writes a day as "30 Oct"', () => {
    expect(dayMonth('2026-10-30')).toBe('30 Oct');
    expect(dayMonth('2026-11-01')).toBe('1 Nov');
    expect(dayMonth('2026-13-01')).toBe('2026-13-01');
  });
});

describe('creditsView', () => {
  const credits = budgetsAnswer().claudeUse.credits;
  const view = creditsView(credits);

  it('says the month and what the credits pay for', () => {
    expect(view.subtitle).toBe('The app’s own runs: edits, re-edits, renders · October');
  });

  it('puts the share used in the gauge, with "$52 of $200" under it and a tick for the month', () => {
    expect(view.gauge).toMatchObject({
      percent: '26%',
      caption: '$52 of $200',
      tickLabel: '76% of the month gone',
    });
    expect(view.gauge.used).toBeCloseTo(0.261, 3);
    expect(view.gauge.tick).toBeCloseTo(0.758, 2);
  });

  it('says what is left in first passes at $11.50', () => {
    const left = view.stats[0];
    expect(left).toEqual({
      label: 'Left',
      value: '$148',
      note: 'about 13 more first passes at $11.50 each',
    });
  });

  it('says the spend per day since the app moved to the API key', () => {
    expect(view.stats[1]).toEqual({
      label: 'Spending',
      value: '$35 a day',
      note: 'since 23 Oct, when the app moved to the API key',
    });
  });

  it('says when the pace runs it out, and calls it "Spending fast"', () => {
    expect(view.stats[2]).toMatchObject({
      label: 'At this pace',
      value: 'runs out about 28 Oct',
      note: '3 days before the month ends',
      warn: true,
    });
    expect(view.chip).toEqual({ label: 'Spending fast', tone: 'warn' });
  });

  it('says "a day before the month ends" for one day', () => {
    const one = creditsView({ ...credits, runOutDay: '2026-10-30', runOutDaysBeforeEnd: 1 });
    expect(one.stats[2]?.note).toBe('a day before the month ends');
  });

  it('says "lasts the month", with the month-end figure, and "On pace", when the pace is slow', () => {
    const slow = creditsView(budgetsAnswer({ usage: [appLine('edit', 4, 6)] }).claudeUse.credits);
    expect(slow.chip).toEqual({ label: 'On pace', tone: 'good' });
    expect(slow.stats[2]?.value).toBe('lasts the month');
    expect(slow.stats[2]?.warn).toBeUndefined();
    expect(slow.stats[2]?.note).toMatch(/^about \$\d+ by the end of the month$/);
  });

  it('has no chip and nothing to say about the pace when nothing is spent', () => {
    const idle = creditsView(budgetsAnswer({ usage: [] }).claudeUse.credits);
    expect(idle.chip).toBeNull();
    expect(idle.stats[1]?.value).toBe('Nothing yet');
    expect(idle.stats[2]?.value).toBe('nothing spent yet');
    expect(idle.gauge.percent).toBe('0%');
  });

  it('says "Used up" when all of it is spent', () => {
    const used = creditsView({
      ...credits,
      status: 'used-up',
      usedShare: 1.2,
      spentUsd: 240,
      leftUsd: 0,
      firstPasses: 0,
      runOutDay: null,
      runOutDaysBeforeEnd: null,
    });
    expect(used.chip).toEqual({ label: 'Used up', tone: 'bad' });
    expect(used.stats[0]?.note).toBe('nothing left until the credits reset on the 1st');
    expect(used.stats[2]?.value).toBe('used up');
    expect(used.gauge.percent).toBe('120%');
  });

  it('says "since 1 Nov" in a month after the switch month', () => {
    const november = creditsView({ ...credits, since: '2026-11-01', monthStart: '2026-11-01' });
    expect(november.stats[1]?.note).toBe('since 1 Nov, the start of the month');
    expect(november.subtitle).toContain('November');
  });
});

describe('planView', () => {
  const answer = budgetsAnswer();
  const plan = answer.claudeUse.plan;
  const view = planView(plan, answer.generatedAt, ZONE);

  it('puts the weekly limit in the gauge, with a tick for how much of the 7 days has gone', () => {
    expect(view.empty).toBe(false);
    expect(view.gauge).toMatchObject({
      percent: '96%',
      caption: 'of the weekly limit',
      tickLabel: '95% of the week gone',
    });
    expect(view.gauge.used).toBe(0.96);
  });

  it('says when the window resets, on the clock of the time zone', () => {
    expect(view.subtitle).toBe('Your Claude Code sessions · resets Sat 21:00');
    expect(resetText('2026-10-24T18:00:00.000Z', ZONE)).toBe('Sat 21:00');
    expect(resetText('2026-10-24T18:00:00.000Z', 'UTC')).toBe('Sat 18:00');
  });

  it('calls 96% "Near the limit", and 100% or a refusal "Limit reached", and 40% nothing', () => {
    expect(view.chip).toEqual({ label: 'Near the limit', tone: 'warn' });
    expect(
      planView(
        { ...plan, week: plan.week && { ...plan.week, utilization: 0.8 } },
        answer.generatedAt,
        ZONE,
      ).chip?.label,
    ).toBe('Near the limit');
    expect(
      planView(
        { ...plan, week: plan.week && { ...plan.week, utilization: 0.79 } },
        answer.generatedAt,
        ZONE,
      ).chip,
    ).toBeNull();
    expect(
      planView(
        { ...plan, week: plan.week && { ...plan.week, utilization: 1 } },
        answer.generatedAt,
        ZONE,
      ).chip?.label,
    ).toBe('Limit reached');
    expect(
      planView(
        { ...plan, status: 'rejected', week: plan.week && { ...plan.week, utilization: 0.5 } },
        answer.generatedAt,
        ZONE,
      ).chip?.label,
    ).toBe('Limit reached');
  });

  it('has the five-hour window as a bar', () => {
    expect(view.fiveHour).toEqual({ percent: '3%', share: 0.03 });
    expect(planView({ ...plan, fiveHour: null }, answer.generatedAt, ZONE).fiveHour).toBeNull();
  });

  it('says what the sessions would have cost at the API, for a $200 plan', () => {
    expect(view.stats[0]).toEqual({
      label: 'Covered this week',
      value: '$1,036 of API value',
      note: 'for a $200-a-month plan, about $46 a week',
    });
  });

  it('says when the plan was last read, and how long ago', () => {
    expect(view.stats[1]).toEqual({
      label: 'Last reading',
      value: '24 Oct, 11:50',
      note: '10 minutes ago',
    });
    expect(readingText('2026-10-23T09:09:39.312Z', ZONE)).toBe('23 Oct, 12:09');
  });

  it('is empty, and says so, with no reading for this week', () => {
    const none = planView(budgetsAnswer({ limits: [] }).claudeUse.plan, answer.generatedAt, ZONE);
    expect(none.empty).toBe(true);
    expect(none.gauge).toMatchObject({
      percent: '–',
      caption: 'no reading for this week yet',
      used: 0,
      tick: null,
    });
    expect(none.chip).toBeNull();
    expect(none.fiveHour).toBeNull();
    expect(none.stats[0]?.label).toBe('Covered, last 7 days');
    expect(none.stats[1]).toMatchObject({ label: 'Last reading', value: 'None yet' });
  });

  it('still names the last reading when its week is over', () => {
    const old = budgetsAnswer({
      limits: [
        {
          ...reading(0.9),
          at: '2026-10-17T08:00:00.000Z',
          sevenDay: { utilization: 0.9, resetsAt: '2026-10-18T00:00:00.000Z' },
          fiveHour: null,
        },
      ],
    });
    const stale = planView(old.claudeUse.plan, old.generatedAt, ZONE);
    expect(stale.empty).toBe(true);
    expect(stale.stats[1]).toMatchObject({ value: '17 Oct, 11:00', note: '7 days ago' });
  });
});

describe('agoText', () => {
  const now = '2026-10-24T12:00:00.000Z';
  it.each([
    ['2026-10-24T11:59:30.000Z', 'just now'],
    ['2026-10-24T11:50:00.000Z', '10 minutes ago'],
    ['2026-10-24T10:00:00.000Z', '2 hours ago'],
    ['2026-10-24T11:00:00.000Z', '1 hour ago'],
    ['2026-10-21T12:00:00.000Z', '3 days ago'],
  ])('writes %s as %s', (at, text) => {
    expect(agoText(at, now)).toBe(text);
  });
});

describe('planReadingIsStale', () => {
  const generatedAt = '2026-10-24T12:00:00.000Z';
  it('is stale with no reading, and past 10 minutes, not at exactly 10', () => {
    expect(planReadingIsStale({ lastReadingAt: null }, generatedAt)).toBe(true);
    expect(planReadingIsStale({ lastReadingAt: '2026-10-24T11:50:00.000Z' }, generatedAt)).toBe(
      false,
    );
    expect(planReadingIsStale({ lastReadingAt: '2026-10-24T11:49:59.000Z' }, generatedAt)).toBe(
      true,
    );
    expect(planReadingIsStale({ lastReadingAt: '2026-10-24T11:58:00.000Z' }, generatedAt)).toBe(
      false,
    );
  });
});

describe('spendListView', () => {
  const credits = budgetsAnswer().claudeUse.credits;
  const view = spendListView(credits.tags, { extra: 'credits' });

  it('lists the big tags biggest first, with bars next to the biggest', () => {
    expect(view.empty).toBe(false);
    expect(view.rows.map((row) => row.label)).toEqual(['revise', 'edit']);
    expect(view.rows[0]).toEqual({
      label: 'revise',
      barPercent: 100,
      usd: '$39',
      share: '75%',
      extra: '≈ 20% of credits',
      nothing: false,
    });
    expect(view.rows[1]).toMatchObject({
      label: 'edit',
      usd: '$12',
      share: '23%',
      extra: '≈ 6% of credits',
    });
    expect(view.rows[1]?.barPercent).toBeCloseTo(30.8, 1);
  });

  it('folds the tags under 3% into one row that says how many, how much, and who', () => {
    expect(view.fold?.title).toBe('12 smaller tags · 2.3%');
    expect(view.fold?.preview).toBe('graphic, note-topics, fix-route, generate …');
    expect(view.fold?.rows).toHaveLength(12);
  });

  it('draws the folded tags next to the biggest of them, and tags with no use faded as "nothing yet"', () => {
    const rows = view.fold?.rows ?? [];
    expect(rows[0]).toMatchObject({
      label: 'graphic',
      barPercent: 100,
      usd: '$1.15',
      share: '2.2%',
      extra: '≈ 1% of credits',
    });
    expect(rows[1]).toMatchObject({
      label: 'note-topics',
      usd: '$0.06',
      share: '<0.5%',
      extra: '< 1% of credits',
    });
    expect(rows[2]).toMatchObject({
      label: 'fix-route',
      nothing: true,
      usd: '$0.00',
      share: '0%',
      extra: '',
    });
  });

  it('has no fold when nothing is small, and says "empty" when nothing is spent', () => {
    const jobs = spendListView(credits.jobs, { extra: 'credits' });
    expect(jobs.fold).toBeNull();
    expect(jobs.rows.map((row) => row.label)).toEqual(['Falcon FPV · Demo 2', 'יעל כהן · Demo 2']);
    expect(jobs.rows[0]?.extra).toBe('≈ 20% of credits');
    expect(
      spendListView(budgetsAnswer({ usage: [] }).claudeUse.credits.tags, { extra: 'credits' })
        .empty,
    ).toBe(true);
  });

  it('writes each session tag’s slice of the limit in the last column', () => {
    const plan = budgetsAnswer().claudeUse.plan;
    const sessions = spendListView(plan.tags, { extra: 'limit' });
    expect(sessions.rows.map((row) => row.label)).toEqual([
      'orchestration',
      'development',
      'planning',
      'design',
      'process',
      'qa',
    ]);
    expect(sessions.rows[0]).toMatchObject({ usd: '$470', share: '45%', extra: '≈ 44% of limit' });
    expect(sessions.rows[1]?.extra).toBe('≈ 33% of limit');
    expect(sessions.fold?.title).toBe('2 smaller tags · <0.5%');
    expect(sessions.fold?.rows.map((row) => row.extra)).toEqual(['< 1% of limit', '< 1% of limit']);
  });

  it('leaves the last column empty when there is no reading to take a slice of', () => {
    const plan = budgetsAnswer({ limits: [] }).claudeUse.plan;
    const sessions = spendListView(plan.tags, { extra: 'limit' });
    expect(sessions.rows.every((row) => row.extra === '')).toBe(true);
  });
});

describe('the lines under the lists', () => {
  it('says which tag took most of the credits, in plain words', () => {
    expect(creditsSummary(budgetsAnswer().claudeUse.credits.tags)).toBe('Re-edits took 75%.');
  });

  it('says nothing when no tag took half', () => {
    const tags = budgetsAnswer().claudeUse.credits.tags;
    expect(
      creditsSummary({ ...tags, rows: tags.rows.map((row) => ({ ...row, share: 0.4 })) }),
    ).toBeNull();
    expect(creditsSummary(budgetsAnswer({ usage: [] }).claudeUse.credits.tags)).toBeNull();
  });

  it('names the two biggest session tags and how a slice is worked out', () => {
    expect(planSummary(budgetsAnswer().claudeUse.plan)).toBe(
      'Orchestration and development alone used about 76% of this week’s limit. Each tag’s slice is its share of session use, times the 96% the plan reports.',
    );
  });

  it('says there is no reading, without claiming a slice, when the plan has none', () => {
    expect(planSummary(budgetsAnswer({ limits: [] }).claudeUse.plan)).toMatch(
      /^There is no reading of the plan for this week yet/,
    );
    expect(planSummary(budgetsAnswer({ usage: [], limits: [] }).claudeUse.plan)).toBeNull();
  });
});
