import type { AnalyticsResponse, HealthResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { analyticsKey } from '@/data/analytics-query';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeAnalyticsResponse } from '@/data/test-utils';
import {
  ANALYTICS_CARDS,
  ANALYTICS_SECTIONS,
  ANALYTICS_TILE_COPY,
} from '@/features/analytics/analytics-copy';
import { renderApp, renderAt } from '@/lib/test-router';
import { AnalyticsPage } from './AnalyticsPage';

const HEALTH: HealthResponse = {
  ok: true,
  version: '0.13.19',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: true,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

/**
 * The page on its own, with `data` as the server's answer (`null`: none yet), at `path` (the
 * address says the period: `/analytics?period=week`).
 */
async function bare(
  data: AnalyticsResponse | null = makeAnalyticsResponse(),
  skeletonDelayMs?: number,
  path = '/analytics',
) {
  const client = createTestQueryClient();
  if (data) client.setQueryData(analyticsKey(data.period), data);
  return renderAt(path, <AnalyticsPage skeletonDelayMs={skeletonDelayMs} />, client);
}

/** The app at /analytics, as the engine's health answer (the switch) and the numbers leave it. */
async function app(
  health: HealthResponse | null,
  data: AnalyticsResponse | null = makeAnalyticsResponse(),
  path = '/analytics',
) {
  const client = createTestQueryClient();
  if (health) client.setQueryData(HEALTH_KEY, health);
  if (data) client.setQueryData(analyticsKey(data.period), data);
  return renderApp(path, client);
}

/** The whole `<section>` of the card called `title`. */
function card(markup: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    markup.match(new RegExp(`<section[^>]*aria-label="${escaped}"[^>]*>.*?</section>`, 's'))?.[0] ??
    ''
  );
}

/** The Week | Month switch: the only thing on the page that can be pressed. */
const PERIOD_SWITCH = /<div role="group" aria-label="Period".*?<\/div>/s;

const TILE_TITLES = Object.values(ANALYTICS_TILE_COPY).map((tile) => tile.title);
/** The cards, in the order the page draws them. */
const CARD_TITLES = [
  ANALYTICS_CARDS.deliveredPerDay,
  ANALYTICS_CARDS.footagePerWeek,
  ANALYTICS_CARDS.typicalJob,
  ANALYTICS_CARDS.approvedFirstTime,
  ANALYTICS_CARDS.noteTopics,
  ANALYTICS_CARDS.rerunsPerApproved,
  ANALYTICS_CARDS.apiCredits,
  ANALYTICS_CARDS.maxPlan,
  ANALYTICS_CARDS.creditsPaidFor,
  ANALYTICS_CARDS.planUsage,
  ANALYTICS_CARDS.creditsThroughMonth,
  ANALYTICS_CARDS.busiestWeek,
].map((c) => c.title);

/** The cards of the two budgets: they say their own empty words, not "No data yet". */
const BUDGET_TITLES: string[] = [
  ANALYTICS_CARDS.apiCredits,
  ANALYTICS_CARDS.maxPlan,
  ANALYTICS_CARDS.creditsPaidFor,
  ANALYTICS_CARDS.planUsage,
  ANALYTICS_CARDS.creditsThroughMonth,
].map((c) => c.title);

describe('/analytics with the switch on', () => {
  it('shows the title, then the three sections in order: Jobs, Reviews, Claude use', async () => {
    const markup = await app(HEALTH);
    expect(markup).toMatch(/<h1[^>]*>Analytics<\/h1>/);
    const order = [
      markup.indexOf('<h1'),
      markup.indexOf('>Jobs</h2>'),
      markup.indexOf('>Reviews</h2>'),
      markup.indexOf('>Claude use</h2>'),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('is not the "Page not found" page', async () => {
    const markup = await app(HEALTH);
    expect(markup).not.toContain('Page not found');
    expect(markup).not.toContain('No such page');
  });

  it('has Analytics as the current page in the sidebar and as the last step of the breadcrumb', async () => {
    const markup = await app(HEALTH);
    const link = markup.match(/<a [^>]*href="\/analytics"[^>]*>/)?.[0] ?? '';
    expect(link).toContain('aria-current="page"');
    expect(markup).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Analytics<\/span>/);
  });

  it('says what each section is for, in the one line of the board', async () => {
    const markup = await bare();
    for (const section of Object.values(ANALYTICS_SECTIONS)) {
      expect(markup).toContain(`>${section.title}</h2>`);
      expect(markup).toContain(`>${section.subtitle}</p>`);
    }
    expect(ANALYTICS_SECTIONS.jobs.subtitle).toBe('How much gets done and how long it takes');
    expect(ANALYTICS_SECTIONS.reviews.subtitle).toBe(
      'How often you approve first time, and what your notes are about',
    );
    expect(ANALYTICS_SECTIONS.claudeUse.subtitle).toBe(
      'Two budgets: API credits pay for the app’s own runs, and your Claude plan covers your Claude Code sessions',
    );
  });

  it('has the five tiles of the top row, in order', async () => {
    const markup = await bare();
    expect(TILE_TITLES).toEqual([
      'Jobs finished',
      'Clients',
      'Files in → ready',
      'Editing time',
      'Approved first time',
    ]);
    const at = TILE_TITLES.map((title) => markup.indexOf(`aria-label="${title}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('has every card of the board, in order, with its title and subtitle', async () => {
    const markup = await bare();
    expect(CARD_TITLES).toEqual([
      'Jobs delivered per day',
      'Footage edited per week',
      'A typical job, step by step',
      'Approved first time, by week',
      'What your notes are about',
      'Re-runs per approved job, by week',
      'API credits',
      'Max plan, this week',
      'What the API credits paid for',
      'What used the plan this week',
      'API credits and plan through the month',
      'Busiest week, last 8 weeks',
    ]);
    const at = CARD_TITLES.map((title) => markup.indexOf(`aria-label="${title}"`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(card(markup, 'Busiest week, last 8 weeks')).toContain(
      'The plan’s weekly peak, and what the app spent of the month’s credits',
    );
    expect(card(markup, 'A typical job, step by step')).toContain(
      'The median job, last 30 days; “vs before” is the 30 days before',
    );
  });

  it('puts the sections’ cards under their own heading', async () => {
    const markup = await bare();
    const jobs = markup.indexOf('>Jobs</h2>');
    const reviews = markup.indexOf('>Reviews</h2>');
    const claude = markup.indexOf('>Claude use</h2>');
    const at = (title: string) => markup.indexOf(`aria-label="${title}"`);
    expect(at('Jobs finished')).toBeGreaterThan(jobs);
    expect(at('A typical job, step by step')).toBeLessThan(reviews);
    expect(at('Approved first time, by week')).toBeGreaterThan(reviews);
    expect(at('What your notes are about')).toBeLessThan(claude);
    expect(at('API credits')).toBeGreaterThan(claude);
  });

  it('says "No data yet" in every card and shows a dash in every tile, until their work items fill them in', async () => {
    const markup = await bare();
    for (const title of TILE_TITLES) {
      expect(card(markup, title), title).toContain('>—</span>');
    }
    for (const title of CARD_TITLES.filter((card) => !BUDGET_TITLES.includes(card))) {
      // Each card says its own empty line (AN2's typical job and AN3's notes have their own).
      expect(card(markup, title), title).toMatch(
        /No data yet|No review notes yet|Not enough finished jobs yet/,
      );
    }
    expect(
      markup.match(/No data yet|No review notes yet|Not enough finished jobs yet/g),
    ).toHaveLength(7);
  });

  it('is read-only: no buttons, no links, no inputs, bar the Week | Month switch', async () => {
    const markup = (await bare()).replace(PERIOD_SWITCH, '');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<select');
  });
});

describe('/analytics layout', () => {
  it('has the top row as 5 columns with a 16 px gap, and 2 columns under 1000 px', async () => {
    const markup = await bare();
    const grid = markup.match(/<div class="grid grid-cols-2 gap-4[^"]*">/)?.[0] ?? '';
    expect(grid).toContain('min-[1000px]:grid-cols-5');
  });

  it('has the cards on a 6-column grid with a 24 px gap, and one column under 1000 px', async () => {
    const markup = await bare();
    const grids = markup.match(/<div class="grid grid-cols-1 gap-6[^"]*">/g) ?? [];
    // Deliveries and footage; the typical job; approval and notes; re-runs; the two gauges of
    // Claude use; its three charts. The two lists have a grid of their own that lines them up at the top.
    expect(grids).toHaveLength(6);
    for (const grid of grids) expect(grid).toContain('min-[1000px]:grid-cols-6');
    expect(markup).toMatch(
      /<div class="grid grid-cols-1 items-start gap-6 min-\[1000px\]:grid-cols-6">/,
    );
  });

  it.each([
    ['Jobs delivered per day', 'min-[1000px]:col-span-3', 'h-[340px]'],
    ['Footage edited per week', 'min-[1000px]:col-span-3', 'h-[340px]'],
    ['A typical job, step by step', 'min-[1000px]:col-span-6', 'h-[470px]'],
    ['Approved first time, by week', 'min-[1000px]:col-span-3', 'h-[500px]'],
    ['What your notes are about', 'min-[1000px]:col-span-3', 'h-[500px]'],
    ['API credits', 'min-[1000px]:col-span-3', 'min-h-[300px]'],
    ['Max plan, this week', 'min-[1000px]:col-span-3', 'min-h-[300px]'],
    ['What the API credits paid for', 'min-[1000px]:col-span-3', 'min-h-[300px]'],
    ['What used the plan this week', 'min-[1000px]:col-span-3', 'min-h-[300px]'],
    ['API credits and plan through the month', 'min-[1000px]:col-span-3', 'min-h-[400px]'],
    ['Busiest week, last 8 weeks', 'min-[1000px]:col-span-3', 'min-h-[400px]'],
  ])('lays out %s as %s, %s high', async (title, span, height) => {
    const markup = await bare();
    const tag = markup.match(new RegExp(`<section[^>]*aria-label="${title}"[^>]*>`))?.[0] ?? '';
    expect(tag).toContain(span);
    expect(tag).toContain(height);
  });

  it('keeps the page to 1400 px wide, with 24 px between its parts', async () => {
    const markup = await bare();
    expect(markup).toMatch(/<div class="flex max-w-\[1400px\] flex-col gap-6">/);
  });

  it('draws every card with a 12 px radius and a border, like the Money banners', async () => {
    const markup = await bare();
    for (const title of CARD_TITLES) {
      const tag = markup.match(new RegExp(`<section[^>]*aria-label="${title}"[^>]*>`))?.[0] ?? '';
      expect(tag, title).toContain('rounded-[12px]');
      expect(tag, title).toContain('border');
    }
  });
});

describe('/analytics while the first answer is on its way', () => {
  it('draws nothing in place of the cards at first: a skeleton earns its place after 300 ms', async () => {
    const markup = await bare(null);
    expect(markup).not.toContain('data-skeleton-card');
    expect(markup).not.toContain('aria-label="Jobs finished"');
    expect(markup).not.toContain('No data yet');
    // The title and the section headings are already there.
    expect(markup).toMatch(/<h1[^>]*>Analytics<\/h1>/);
    expect(markup).toContain('>Jobs</h2>');
    expect(markup).toContain('>Reviews</h2>');
    expect(markup).toContain('>Claude use</h2>');
  });

  it('keeps the room of the cards, so the page does not jump when they arrive', async () => {
    const markup = await bare(null);
    for (const size of ['h-[340px]', 'h-[470px]', 'h-[500px]', 'h-[400px]', 'min-h-[180px]']) {
      expect(markup).toContain(size);
    }
  });

  it('draws a grey card for each tile and card once the wait is real (no delay), and tells screen readers', async () => {
    const markup = await bare(null, 0);
    expect(markup.match(/data-skeleton-card/g)).toHaveLength(17);
    expect(markup).toContain('Loading the analytics…');
    expect(markup).not.toContain('No data yet');
  });

  it('waits 300 ms before a skeleton by default', async () => {
    const { ANALYTICS_SKELETON_DELAY_MS } = await import('@/features/analytics/AnalyticsStates');
    expect(ANALYTICS_SKELETON_DELAY_MS).toBe(300);
  });
});

describe('/analytics with the switch off', () => {
  it('shows Not found, as if the page did not exist', async () => {
    const markup = await app({ ...HEALTH, analytics: false });
    expect(markup).toContain('No such page.');
    expect(markup).not.toMatch(/<h1[^>]*>Analytics<\/h1>/);
    expect(markup).not.toContain('aria-label="Jobs finished"');
  });

  it('says Page not found in the breadcrumb, and links no Analytics in the sidebar', async () => {
    const markup = await app({ ...HEALTH, analytics: false });
    expect(markup).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Page not found<\/span>/);
    expect(markup).not.toContain('href="/analytics"');
    expect(markup).toContain('aria-label="Analytics (coming in a later phase)"');
  });

  it('shows Not found even when the numbers happen to be cached', async () => {
    const markup = await app({ ...HEALTH, analytics: false }, makeAnalyticsResponse());
    expect(markup).toContain('No such page.');
    expect(markup).not.toContain('No data yet');
  });

  it('shows nothing, not Not found, until the engine has said which', async () => {
    const markup = await app(null);
    expect(markup).not.toContain('No such page.');
    expect(markup).not.toMatch(/<h1[^>]*>Analytics<\/h1>/);
  });
});

describe('/analytics and its Week | Month switch', () => {
  const week = () => makeAnalyticsResponse({ period: 'week' });
  /** The switch's two buttons as [label, pressed]. */
  const buttons = (markup: string) =>
    [
      ...(markup.match(PERIOD_SWITCH)?.[0] ?? '').matchAll(
        /aria-pressed="(\w+)"[^>]*>(\w+)<\/button>/g,
      ),
    ].map(([, pressed, label]) => [label, pressed === 'true']);

  it('sits at the right of the title with Week then Month, as a named group of two buttons', async () => {
    const markup = await bare();
    expect(markup).toMatch(
      /<h1[^>]*>Analytics<\/h1><div role="group" aria-label="Period" class="[^"]*rounded-lg bg-muted/,
    );
    expect(buttons(markup)).toEqual([
      ['Week', false],
      ['Month', true],
    ]);
    // In the title row, which spreads its two ends.
    expect(markup).toMatch(/<div class="flex min-h-9 items-center justify-between[^"]*"><h1/);
  });

  it('is on Month for /analytics, for ?period=month and for a period it does not know', async () => {
    for (const path of ['/analytics', '/analytics?period=month', '/analytics?period=year']) {
      expect(buttons(await bare(makeAnalyticsResponse(), undefined, path)), path).toEqual([
        ['Week', false],
        ['Month', true],
      ]);
    }
  });

  it('is on Week for ?period=week, and says Week in the cards', async () => {
    const markup = await bare(week(), undefined, '/analytics?period=week');
    expect(buttons(markup)).toEqual([
      ['Week', true],
      ['Month', false],
    ]);
    expect(markup).toContain('aria-label="Footage edited per day"');
    expect(markup).not.toContain('aria-label="Footage edited per week"');
  });

  it('reads the period from the address in the app too, and asks the query of that period', async () => {
    const markup = await app(HEALTH, week(), '/analytics?period=week');
    expect(buttons(markup)).toEqual([
      ['Week', true],
      ['Month', false],
    ]);
    expect(markup).toContain('aria-label="Busiest day, last 14 days"');
    // The month's numbers are not what a week address shows.
    const notLoaded = await app(HEALTH, makeAnalyticsResponse(), '/analytics?period=week');
    expect(notLoaded).not.toContain('aria-label="Jobs finished"');
  });

  it('shows the words of the period the numbers are for, so the old page stays whole while the other loads', async () => {
    // The address says Week, but what the query holds is still the month's answer (the placeholder
    // while the week's numbers come): the cards keep to the words of the numbers they show.
    const client = createTestQueryClient();
    client.setQueryData(analyticsKey('week'), makeAnalyticsResponse());
    const stale = await renderAt('/analytics?period=week', <AnalyticsPage />, client);
    expect(buttons(stale)[0]).toEqual(['Week', true]);
    expect(stale).toContain('aria-label="Footage edited per week"');
    expect(stale).toContain('aria-label="Busiest week, last 8 weeks"');
  });

  it('says the week words in every tile and card', async () => {
    const markup = await bare(week(), undefined, '/analytics?period=week');
    for (const title of [
      'Footage edited per day',
      'Approved first time, by day',
      'Busiest day, last 14 days',
      'API credits',
      'Max plan, this week',
      'What the API credits paid for',
      'What used the plan this week',
      'API credits and plan through the week',
      'A typical job, step by step',
      'Jobs delivered per day',
      'What your notes are about',
    ]) {
      expect(markup, title).toContain(`aria-label="${title}"`);
    }
    expect(card(markup, 'Jobs finished')).toContain('Last 7 days');
    expect(card(markup, 'Clients')).toContain('With a job finished, last 7 days');
    expect(card(markup, 'A typical job, step by step')).toContain(
      'The median job, last 7 days; “vs before” is the 7 days before',
    );
    expect(card(markup, 'Busiest day, last 14 days')).toContain(
      'The plan’s peak five-hour use, and what the app spent of the month’s credits',
    );
    expect(markup).not.toContain('30 days');
  });

  it('keeps the same sections, tiles and cards in both periods, in the same order', async () => {
    const order = (markup: string) => [...markup.matchAll(/<section aria-label="([^"]+)"/g)].length;
    expect(order(await bare(week(), undefined, '/analytics?period=week'))).toBe(17);
    expect(order(await bare())).toBe(17);
  });

  it('shows the switch at once, before any numbers, and when the engine cannot be reached', async () => {
    const markup = await bare(null, undefined, '/analytics?period=week');
    expect(buttons(markup)).toEqual([
      ['Week', true],
      ['Month', false],
    ]);
  });
});
