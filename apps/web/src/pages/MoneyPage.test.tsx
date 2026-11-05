import type { MoneyResponse } from '@studio/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moneyKey } from '@/data/money-query';
import { createTestQueryClient, makeMoneyResponse } from '@/data/test-utils';
import { renderApp, renderAt } from '@/lib/test-router';
import { defaultMoneyUiState, moneyUiStore } from '@/stores/money-ui';
import { MoneyPage } from './MoneyPage';

// The Money page's store is the app's one, so every test starts it on October 2026 again.
beforeAll(() => {
  // zustand's server render reads the store's initial state; point it at the current one.
  moneyUiStore.getInitialState = () => moneyUiStore.getState();
});
beforeEach(() => {
  moneyUiStore.setState(defaultMoneyUiState('2026-10'));
});

/** The app at /money with `data` as the server's answer for its month (`null`: none yet). */
async function page(data: MoneyResponse | null = makeMoneyResponse()) {
  const client = createTestQueryClient();
  if (data) client.setQueryData(moneyKey(data.month), data);
  return renderApp('/money', client);
}

/** The whole `<section>` of the banner called `title`. */
function banner(markup: string, title: string): string {
  return (
    markup.match(new RegExp(`<section[^>]*aria-label="${title}"[^>]*>.*?</section>`, 's'))?.[0] ??
    ''
  );
}

function withBanners(banners: Partial<MoneyResponse['banners']>) {
  const base = makeMoneyResponse();
  return makeMoneyResponse({ banners: { ...base.banners, ...banners } });
}

describe('/money', () => {
  it('shows the title with the month at its right, then the banners, the Ledger and the Expenses', async () => {
    const markup = await page();
    expect(markup).toMatch(/<h1[^>]*>Money<\/h1>/);
    const order = [
      markup.indexOf('<h1'),
      markup.indexOf('aria-label="Month"'),
      markup.indexOf('data-banner="income"'),
      markup.indexOf('data-banner="expenses"'),
      markup.indexOf('data-banner="profit"'),
      markup.indexOf('>Ledger</h2>'),
      markup.indexOf('>Expenses</h2>'),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('has Money as the current page in the sidebar and as the last step of the breadcrumb', async () => {
    const markup = await page();
    const sidebarLink = markup.match(/<a [^>]*href="\/money"[^>]*>/)?.[0] ?? '';
    expect(sidebarLink).toContain('aria-current="page"');
    expect(markup).toMatch(/<span[^>]*data-slot="breadcrumb-page"[^>]*>Money<\/span>/);
  });

  it('is not the "Page not found" page', async () => {
    expect(await page()).not.toContain('Page not found');
  });

  it('names the month in the picker, with a calendar icon', async () => {
    const markup = await page();
    const trigger =
      markup.match(/<button[^>]*data-slot="select-trigger"[^>]*>.*?<\/button>/s)?.[0] ?? '';
    expect(trigger).toContain('aria-label="Month"');
    expect(trigger).toContain('role="combobox"');
    expect(trigger).toContain('October 2026');
    expect(trigger).toContain('lucide-calendar');
    expect(trigger).not.toContain('lucide-calendar-days');
  });

  it('names the month in the picker before the first answer, too', async () => {
    const markup = await page(null);
    expect(markup).toContain('October 2026');
  });

  it('follows the month in the store', async () => {
    moneyUiStore.setState({ month: '2026-09' });
    const markup = await page(makeMoneyResponse({ month: '2026-09' }));
    expect(markup).toContain('September 2026');
    // The banners compare with the month before the one shown.
    expect(markup).toContain('vs August');
    expect(markup).not.toContain('vs September');
  });
});

describe('/money when money.json has a mistake', () => {
  const ISSUE = 'charges[2].date: must be a date written YYYY-MM-DD, like 2026-10-14';

  it('shows no warning line while the file is fine', async () => {
    const markup = await page();
    expect(markup).not.toContain('data-money-file');
    expect(markup).not.toContain('money.json has a mistake');
  });

  it('puts the last-good line under the title and above the banners, with the problem under it', async () => {
    const markup = await page(
      makeMoneyResponse({ moneyFile: { status: 'last-good', issue: ISSUE } }),
    );
    const order = [
      markup.indexOf('<h1'),
      markup.indexOf('aria-label="Month"'),
      markup.indexOf('data-money-file="last-good"'),
      markup.indexOf('this page shows the last good numbers'),
      markup.indexOf(ISSUE),
      markup.indexOf('data-banner="income"'),
      markup.indexOf('>Ledger</h2>'),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('says the numbers are defaults and Mark delivered is off when no good version is saved', async () => {
    const markup = await page(
      makeMoneyResponse({ moneyFile: { status: 'defaults', issue: ISSUE } }),
    );
    expect(markup).toContain('data-money-file="defaults"');
    expect(markup).toContain(
      'no good version is saved, so prices and expenses are defaults and Mark delivered is off',
    );
    expect(markup).not.toContain('last good numbers');
  });

  it('shows nothing before the first answer', async () => {
    expect(await page(null)).not.toContain('data-money-file');
  });
});

describe('/money banners', () => {
  it('are Income, Expenses and Profit, each with its description', async () => {
    const markup = await page();
    expect(banner(markup, 'Income')).toContain('3 jobs at ₪200');
    expect(banner(markup, 'Expenses')).toContain('Subscriptions and API charges');
    expect(banner(markup, 'Profit')).toContain('Income minus expenses');
  });

  it('show the amounts in whole shekels, 44 px, tabular', async () => {
    const markup = await page();
    for (const [title, value] of [
      ['Income', '₪5,200'],
      ['Expenses', '₪960'],
      ['Profit', '₪4,240'],
    ] as const) {
      const card = banner(markup, title);
      const amount = card.match(new RegExp(`<span[^>]*>${value}</span>`))?.[0] ?? '';
      expect(amount, title).toContain('text-[44px]');
      expect(amount, title).toContain('tabular-nums');
      expect(amount, title).toContain('font-semibold');
    }
  });

  it('say how each changed since September', async () => {
    const markup = await page();
    expect(banner(markup, 'Income')).toContain('+₪800 vs September (₪4,400)');
    expect(banner(markup, 'Income')).toContain('+18%');
    expect(banner(markup, 'Expenses')).toContain('+₪22 vs September (₪938)');
    expect(banner(markup, 'Profit')).toContain('+₪778 vs September (₪3,462)');
  });

  it('are green when the change is good and red when it is bad: more expenses are bad', async () => {
    const markup = await page();
    expect(banner(markup, 'Income')).toContain('data-tone="good"');
    expect(banner(markup, 'Expenses')).toContain('data-tone="bad"');
    expect(banner(markup, 'Profit')).toContain('data-tone="good"');
    expect(banner(markup, 'Income')).toContain('border-[rgba(74,222,128,0.35)]');
    expect(banner(markup, 'Income')).toContain('bg-[rgba(34,197,94,0.07)]');
    expect(banner(markup, 'Expenses')).toContain('border-[rgba(248,113,113,0.38)]');
    expect(banner(markup, 'Expenses')).toContain('bg-[rgba(239,68,68,0.07)]');
  });

  it('turn red when income and profit fall (the board’s badMonth), with a down arrow and a minus', async () => {
    const markup = await page(
      withBanners({
        income: {
          value: 3800,
          previous: 4400,
          history: [3200, 3600, 3400, 3800, 4000, 3800, 4400, 3800],
          unpaid: { value: 600, count: 3 },
        },
        profit: {
          value: 2840,
          previous: 3462.1,
          history: [2300, 2690, 2495, 2870, 3060, 2865, 3462.1, 2840],
        },
      }),
    );
    const income = banner(markup, 'Income');
    expect(income).toContain('data-tone="bad"');
    expect(income).toContain('−14%');
    expect(income).toContain('−₪600 vs September (₪4,400)');
    expect(income).toContain('lucide-trending-down');
    expect(income).toContain('text-[#F87171]');
    expect(banner(markup, 'Profit')).toContain('data-tone="bad"');
  });

  it('are grey with a dash and "Same as September" when nothing changed', async () => {
    const flat = {
      value: 4400,
      previous: 4400,
      history: [4400, 4400, 4400, 4400, 4400, 4400, 4400, 4400],
      unpaid: { value: 0, count: 0 },
    };
    const income = banner(await page(withBanners({ income: flat })), 'Income');
    expect(income).toContain('data-tone="flat"');
    expect(income).toContain('Same as September');
    expect(income).toContain('0%');
    expect(income).toContain('lucide-minus');
    expect(income).toContain('text-[#A1A1AA]');
    expect(income).not.toContain('vs September');
  });

  it('use the arrow that goes with the change', async () => {
    const markup = await page();
    expect(banner(markup, 'Income')).toContain('lucide-trending-up');
    expect(banner(markup, 'Income')).not.toContain('lucide-trending-down');
  });

  it('draw the eight months as a 150 × 48 inline SVG, with no chart library', async () => {
    const income = banner(await page(), 'Income');
    const svg = income.match(/<svg[^>]*viewBox="0 0 150 48"[^>]*>.*?<\/svg>/s)?.[0] ?? '';
    expect(svg).toContain('width="150"');
    expect(svg).toContain('height="48"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('<polygon');
    expect(svg).toContain('fill-opacity="0.15"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toContain('stroke-linejoin="round"');
    const points = svg.match(/<polyline[^>]*points="([^"]+)"/)?.[1] ?? '';
    expect(points.split(' ')).toHaveLength(8);
  });

  it('are 196 px high, like the board', async () => {
    const markup = await page();
    for (const title of ['Income', 'Expenses', 'Profit']) {
      expect(banner(markup, title)).toContain('h-[196px]');
    }
  });

  it('say there were no jobs when none were delivered', async () => {
    const markup = await page(makeMoneyResponse({ ledger: [] }));
    expect(banner(markup, 'Income')).toContain('No jobs delivered');
  });
});

describe('/money Income banner: what is not paid yet', () => {
  const owing = (value: number, count: number) => {
    const base = makeMoneyResponse();
    return withBanners({ income: { ...base.banners.income, unpaid: { value, count } } });
  };
  /** The "not paid yet" line of the Income card: from its hairline to the end of the line. */
  const line = (markup: string) =>
    banner(markup, 'Income').match(/<div[^>]*data-unpaid[^>]*>.*?<\/div>/s)?.[0] ?? '';
  const text = (html: string) =>
    html
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]*>/g, '|')
      .replace(/\|+/g, '|');

  it('adds one line saying how much, and how many videos, under the change since last month', async () => {
    const markup = await page(owing(120, 3));
    const income = banner(markup, 'Income');
    expect(text(line(markup))).toBe('|₪120| |not paid yet · 3 videos|');
    // It comes last, below the description, the amount and the change.
    expect(income.indexOf('3 jobs at ₪200')).toBeLessThan(income.indexOf('data-unpaid'));
    expect(income.indexOf('vs September')).toBeLessThan(income.indexOf('data-unpaid'));
  });

  it('has a hairline above it, the amount in medium and the rest muted', async () => {
    const html = line(await page(owing(120, 3)));
    expect(html).toContain('border-t');
    expect(html).toContain('border-white/[0.08]');
    expect(html).toMatch(/<span class="font-medium tabular-nums">₪120<\/span>/);
    expect(html).toMatch(/<span class="text-muted-foreground">not paid yet · 3 videos<\/span>/);
    expect(html).toContain('text-[13px]');
  });

  it('starts with the Jobs list’s Delivered icon at 14 px: a sky disc with a dark arrow', async () => {
    const html = line(await page(owing(120, 3)));
    const svg = html.match(/<svg[^>]*>.*?<\/svg>/s)?.[0] ?? '';
    expect(svg).toContain('width="14"');
    expect(svg).toContain('height="14"');
    expect(svg).toContain('aria-hidden="true"');
    // The shared icon: the sky colour is the Delivered status colour, the arrow is cut out in the
    // page's background colour.
    expect(svg).toContain('text-status-delivered');
    expect(svg).toMatch(/<circle[^>]*fill="currentColor"/);
    expect(svg).toMatch(/<path[^>]*stroke="var\(--background\)"/);
  });

  it('says "1 video" for one', async () => {
    expect(text(line(await page(owing(40, 1))))).toBe('|₪40| |not paid yet · 1 video|');
  });

  it('writes the amount in whole shekels', async () => {
    expect(text(line(await page(owing(1240.6, 31))))).toBe('|₪1,241| |not paid yet · 31 videos|');
  });

  it('is left out when everything is paid, and for the other two cards', async () => {
    const markup = await page(owing(0, 0));
    expect(markup).not.toContain('data-unpaid');
    expect(markup).not.toContain('not paid yet');
    const some = await page(owing(120, 3));
    expect(banner(some, 'Expenses')).not.toContain('data-unpaid');
    expect(banner(some, 'Profit')).not.toContain('data-unpaid');
    expect(some.match(/data-unpaid/g)).toHaveLength(1);
  });

  it('keeps every card 196 px high, with the line and without it', async () => {
    for (const markup of [await page(owing(120, 3)), await page(owing(0, 0))]) {
      for (const title of ['Income', 'Expenses', 'Profit']) {
        expect(banner(markup, title)).toContain('h-[196px]');
      }
    }
  });

  it('closes the three cards up together, so they stay level, while the line shows', async () => {
    const some = await page(owing(120, 3));
    for (const title of ['Income', 'Expenses', 'Profit']) {
      expect(banner(some, title), title).toContain('gap-2');
      expect(banner(some, title), title).not.toContain('gap-3.5');
    }
    const none = await page(owing(0, 0));
    for (const title of ['Income', 'Expenses', 'Profit']) {
      expect(banner(none, title), title).toContain('gap-3.5');
      expect(banner(none, title), title).not.toContain('gap-2');
    }
  });

  it('adds no button: Money stays read-only', async () => {
    const income = banner(await page(owing(120, 3)), 'Income');
    expect(income).not.toContain('<button');
    expect(income).not.toContain('<a ');
  });
});

describe('/money Ledger and Expenses', () => {
  it('has the Ledger section under the banners, with its table (its own tests are in Ledger.test.tsx)', async () => {
    const markup = await page();
    expect(markup).toMatch(
      /<section[^>]*aria-labelledby="ledger-h"[^>]*>.*?<h2 id="ledger-h"[^>]*>Ledger<\/h2>.*?<table[^>]*aria-label="Ledger"/s,
    );
    expect(markup.indexOf('data-banner="profit"')).toBeLessThan(markup.indexOf('id="ledger-h"'));
  });

  it('has the Expenses section (its own tests are in features/money/Expenses.test.tsx)', async () => {
    const markup = await page();
    expect(markup).toMatch(
      /<section[^>]*aria-labelledby="exp-h"[^>]*>.*?<h2 id="exp-h"[^>]*>Expenses<\/h2>/s,
    );
  });
});

describe('/money while the first answer is on its way', () => {
  it('draws nothing in place of the banners at first: a skeleton earns its place after 300 ms', async () => {
    const markup = await page(null);
    expect(markup).not.toContain('data-skeleton-banner');
    expect(markup).not.toContain('data-banner=');
    // The title, the picker and the two sections are already there.
    expect(markup).toMatch(/<h1[^>]*>Money<\/h1>/);
    expect(markup).toContain('>Ledger</h2>');
  });

  it('draws three grey cards once the wait is real (no delay), and tells screen readers', async () => {
    const markup = await renderAt('/money', <MoneyPage skeletonDelayMs={0} />);
    expect(markup.match(/data-skeleton-banner/g)).toHaveLength(3);
    expect(markup).toContain('Loading the month…');
    expect(markup).not.toContain('data-banner=');
  });

  it('waits 300 ms before a skeleton by default', async () => {
    const { MONEY_SKELETON_DELAY_MS } = await import('@/features/money/MoneyStates');
    expect(MONEY_SKELETON_DELAY_MS).toBe(300);
  });
});
