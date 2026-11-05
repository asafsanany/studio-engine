import type { MoneyResponse } from '@studio/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderAt } from '@/lib/test-router';
import { defaultMoneyUiState, type MoneyUiState, moneyUiStore } from '@/stores/money-ui';
import { PhoneMoneyView } from './PhoneMoneyPage';
import { PHONE_MONEY_LAST_GOOD_TEXT } from './phone-money';
import { boardMoney, must } from './test-money';

// The page reads the app's one Money UI store (shared with the Mac page); every test starts it on
// October 2026 again, and a static render reads its initial state.
beforeAll(() => {
  moneyUiStore.getInitialState = () => moneyUiStore.getState();
});
beforeEach(() => {
  moneyUiStore.setState(defaultMoneyUiState('2026-10'));
});

interface Options {
  /** `null` is the page before its first answer. */
  data?: MoneyResponse | null;
  failed?: boolean;
  reconnecting?: boolean;
  store?: Partial<MoneyUiState>;
}

function render({ data = boardMoney(), failed, reconnecting, store }: Options = {}) {
  if (store) moneyUiStore.setState(store);
  return renderAt(
    '/money',
    <PhoneMoneyView
      month="2026-10"
      onMonthChange={() => {}}
      data={data ?? undefined}
      failed={failed}
      reconnecting={reconnecting}
      skeletonDelayMs={0}
    />,
  );
}

/** The whole `<section>` of the banner called `title`. */
function banner(html: string, title: string): string {
  return (
    html.match(new RegExp(`<section[^>]*aria-label="${title}"[^>]*>.*?</section>`, 's'))?.[0] ?? ''
  );
}

const jobIds = (html: string) =>
  [...html.matchAll(/<div[^>]*data-job-id="([^"]*)"/g)].map((m) => m[1]);
const clientIds = (html: string) =>
  [...html.matchAll(/<div[^>]*data-client-id="([^"]*)"/g)].map((m) => m[1]);

describe('<PhoneMoneyView>', () => {
  describe('the title', () => {
    it('is "Money" in a 52 px header with the month picker at its right as an outlined button', async () => {
      const html = await render();
      expect(html).toContain('data-slot="phone-money-page"');
      expect(html).toMatch(/<header[^>]*h-\[52px\]/);
      expect(html).toMatch(/<h1[^>]*>Money<\/h1>/);
      const trigger =
        html.match(/<button[^>]*data-slot="select-trigger"[^>]*>.*?<\/button>/s)?.[0] ?? '';
      expect(trigger).toContain('aria-label="Month"');
      expect(trigger).toContain('October 2026');
      expect(trigger).toContain('data-[size=default]:h-10');
      expect(trigger).toContain('border-white/15');
      expect(trigger).toContain('lucide-chevron-down');
      // The board's button has no calendar icon (the Mac's has).
      expect(trigger).not.toContain('lucide-calendar');
    });

    it('names the month before the first answer, too', async () => {
      expect(await render({ data: null })).toContain('October 2026');
    });
  });

  describe('the money.json warning (board MMoneyWarn)', () => {
    it('is nothing while the file is fine', async () => {
      expect(await render()).not.toContain('data-money-file');
    });

    it('is one line with an amber triangle under the title when the file has a mistake', async () => {
      const html = await render({
        data: boardMoney({
          moneyFile: { status: 'last-good', issue: 'pricePerJob: expected number' },
        }),
      });
      const line = html.match(/<p[^>]*data-money-file="last-good"[^>]*>.*?<\/p>/s)?.[0] ?? '';
      expect(line).toContain('role="status"');
      expect(line).toContain(PHONE_MONEY_LAST_GOOD_TEXT);
      expect(line).toContain('lucide-triangle-alert');
      expect(line).toContain('text-status-held');
      // Between the title and the first banner.
      expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('data-money-file'));
      expect(html.indexOf('data-money-file')).toBeLessThan(html.indexOf('data-banner="income"'));
    });

    it('says so for defaults too, and names the Mac as the place to look', async () => {
      const html = await render({
        data: boardMoney({ moneyFile: { status: 'defaults', issue: null } }),
      });
      expect(html).toContain('data-money-file="defaults"');
      expect(html).toContain('Run pnpm run doctor on the Mac.');
    });
  });

  describe('the banners', () => {
    it('are three, stacked full width in the order Income, Expenses, Profit, under the title', async () => {
      const html = await render();
      const at = ['income', 'expenses', 'profit'].map((kind) =>
        html.indexOf(`data-banner="${kind}"`),
      );
      expect(at.every((i) => i > 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(html).toMatch(/<div[^>]*data-slot="phone-money-banners"[^>]*flex-col/);
      expect(html.indexOf('<h1')).toBeLessThan(at[0] ?? 0);
    });

    it('show the Mac’s amounts: ₪1,040, ₪970 and ₪70 at 36 px, with the pill and the change line', async () => {
      const html = await render();
      const income = banner(html, 'Income');
      expect(income).toContain('26 videos at ₪40');
      expect(income).toMatch(/text-4xl[^>]*>₪1,040</);
      expect(income).toContain('+18%');
      expect(income).toContain('+₪160 vs September (₪880)');
      expect(income).toContain('data-tone="good"');
      const expenses = banner(html, 'Expenses');
      expect(expenses).toMatch(/text-4xl[^>]*>₪970</);
      expect(expenses).toContain('Same as September');
      expect(expenses).toContain('data-tone="flat"');
      // A flat banner's pill is "0%" alone, as the board draws it; the others have their arrow.
      expect(expenses).toMatch(/>0%</);
      expect(expenses).not.toContain('lucide-minus');
      expect(expenses).not.toMatch(/lucide-trending/);
      expect(income).toContain('lucide-trending-up');
      const profit = banner(html, 'Profit');
      expect(profit).toContain('lucide-trending-up');
      expect(profit).toMatch(/text-4xl[^>]*>₪70</);
      expect(profit).toContain('+178%');
      expect(profit).toContain('+₪160 vs September (−₪90)');
    });

    it('draw a 120 × 38 sparkline with its tint, in the card’s accent', async () => {
      const income = banner(await render(), 'Income');
      const svg = income.match(/<svg[^>]*width="120"[^>]*>.*?<\/svg>/s)?.[0] ?? '';
      expect(svg).toContain('height="38"');
      expect(svg).toContain('<polygon');
      expect(svg).toContain('<polyline');
      expect(svg).toContain('text-[#4ADE80]');
    });

    it('give Income, and only Income, the "not paid yet" line with the Delivered icon', async () => {
      const html = await render();
      const income = banner(html, 'Income');
      expect(income).toContain('data-unpaid');
      expect(income).toContain('₪160 not paid yet · 4 videos');
      expect(banner(html, 'Expenses')).not.toContain('data-unpaid');
      expect(banner(html, 'Profit')).not.toContain('data-unpaid');
    });

    it('leave the line out when everything delivered is paid', async () => {
      const base = boardMoney();
      const html = await render({
        data: {
          ...base,
          banners: {
            ...base.banners,
            income: { ...base.banners.income, unpaid: { value: 0, count: 0 } },
          },
        },
      });
      expect(html).not.toContain('data-unpaid');
    });
  });

  describe('the Ledger', () => {
    it('has a heading, the board’s line and the "Every job | By client" switch with Every job pressed', async () => {
      const html = await render();
      expect(html).toMatch(/<h2[^>]*>Ledger<\/h2>/);
      expect(html).toContain('Every video this month, delivered or not. Tap one for the details.');
      const group =
        html.match(/<div[^>]*aria-label="Group the ledger"[^>]*>.*?<\/div>/s)?.[0] ?? '';
      expect(group).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Every job<\/button>/);
      expect(group).toMatch(/<button[^>]*aria-pressed="false"[^>]*>By client<\/button>/);
      expect(group).toContain('h-[34px]');
      expect(group).toContain('grid-cols-2');
    });

    it('lists the first ten videos, newest delivery first, then "Show all 26 videos"', async () => {
      const html = await render();
      expect(jobIds(html)).toEqual([
        'j01',
        'j02',
        'j03',
        'j04',
        'j05',
        'j06',
        ...jobIds(html).slice(6),
      ]);
      expect(jobIds(html)).toHaveLength(10);
      const more = html.match(/<button[^>]*data-slot="phone-money-more"[^>]*>([^<]*)<\/button>/s);
      expect(more?.[1]).toBe('Show all 26 videos');
      expect(more?.[0]).toContain('h-12');
    });

    it('has no pager on the phone', async () => {
      const html = await render();
      expect(html).not.toContain('Showing 1–10');
      expect(html).not.toContain('Go to next page');
      expect(html).not.toContain('Ledger pages');
    });

    it('heads the list with Job and Profit', async () => {
      const html = await render();
      expect(html).toMatch(/<span>Job<\/span><span>Profit<\/span>/);
    });

    it('writes a row as the board does: name, "client · delivered Oct 22 · Not paid yet", profit', async () => {
      const html = await render();
      const row = html.match(/<div[^>]*data-job-id="j01"[^>]*>.*?<\/button>/s)?.[0] ?? '';
      expect(row).toContain('אדריכלות');
      expect(row).toContain('<bdi>LAKESHORE</bdi>');
      expect(row).toContain('delivered Oct 22');
      expect(row).toContain('Not paid yet');
      expect(row).toContain('₪40');
      expect(row).toContain('aria-expanded="false"');
      expect(row).toContain('min-h-[60px]');
    });

    it('colours Not paid yet amber, and Paid and Archived like the rest of the line', async () => {
      const html = await render();
      const paidSpan = (id: string) =>
        html
          .match(
            new RegExp(`data-job-id="${id}".*?<span[^>]*data-paid="[^"]*"[^>]*>[^<]*</span>`, 's'),
          )?.[0]
          ?.match(/<span[^>]*data-paid[^>]*>[^<]*<\/span>$/)?.[0] ?? '';
      expect(paidSpan('j01')).toContain('text-amber-200');
      expect(paidSpan('j01')).toContain('Not paid yet');
      expect(paidSpan('j03')).not.toContain('text-amber-200');
      expect(paidSpan('j03')).toContain('Paid Oct 20');
      expect(paidSpan('j05')).not.toContain('text-amber-200');
      expect(paidSpan('j05')).toContain('Archived');
    });

    it('keeps every row closed to begin with, and opens one row at a time (the store’s open row)', async () => {
      expect(await render()).not.toContain('data-job-detail');
      const html = await render({ store: { open: { kind: 'job', id: 'j02' } } });
      expect(html.match(/data-job-detail="/g)).toHaveLength(1);
      expect(html).toContain('data-job-detail="j02"');
      const open = html.match(/<div[^>]*data-job-id="j02"[^>]*>.*?<\/button>/s)?.[0] ?? '';
      expect(open).toContain('aria-expanded="true"');
      expect(open).toContain('rotate-90');
    });

    it('opens to the Mac’s details: Income, Expenses, Profit and Your time, one line each', async () => {
      const html = await render({ store: { open: { kind: 'job', id: 'j01' } } });
      const detail =
        html.match(/data-job-detail="j01".*?(?=<div[^>]*data-job-id="j02")/s)?.[0] ?? '';
      expect(detail.match(/data-detail="([a-z]+)"/g)).toEqual([
        'data-detail="income"',
        'data-detail="expenses"',
        'data-detail="profit"',
        'data-detail="time"',
      ]);
      expect(detail).toContain('Price ₪40 · delivered Oct 22 · Not paid yet');
      expect(detail).toContain('Nothing paid for this video');
      expect(detail).toContain('Margin 100%');
      expect(detail).toContain('Review and notes · 9 min');
      expect(detail).toContain('₪267/h');
      // The Income amount is green (the Mac's colour for it).
      expect(detail).toMatch(/data-detail="income".*?text-\[#4ADE80\][^>]*>₪40</s);
    });

    it('shows a row’s money as the Mac’s open job does for a job that was charged', async () => {
      const charged = boardMoney();
      const first = charged.ledger[0];
      expect(first).toBeDefined();
      const html = await render({
        data: {
          ...charged,
          ledger: [
            {
              ...must(charged.ledger[0]),
              expenses: 15,
              profit: 25,
              charges: [
                {
                  date: '2026-10-14',
                  item: 'Stock footage',
                  what: 'Clip #1',
                  amountLabel: '₪7.50',
                  ils: 7.5,
                  job: null,
                },
                {
                  date: '2026-10-14',
                  item: 'Stock footage',
                  what: 'Clip #2',
                  amountLabel: '₪7.50',
                  ils: 7.5,
                  job: null,
                },
              ],
            },
            ...charged.ledger.slice(1),
          ],
        },
        store: { open: { kind: 'job', id: 'j01' } },
      });
      expect(html).toContain('Stock footage · 2 clips at ₪7.50 · ₪15.00');
      expect(html).toContain('₪25');
    });

    it('says "No videos in October." for a month with none', async () => {
      const empty = boardMoney({ ledger: [] });
      const html = await render({ data: empty });
      expect(html).toContain('No videos in October.');
      expect(html).not.toContain('phone-money-more');
    });
  });

  describe('By client', () => {
    const byClient = { grouping: 'client' } as const;

    it('has By client pressed, "Client" over the list and the clients who kept the most first', async () => {
      const html = await render({ store: byClient });
      expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>By client<\/button>/);
      expect(html).toMatch(/<span>Client<\/span><span>Profit<\/span>/);
      expect(clientIds(html)).toEqual(['tavo', 'rgm', 'lakeshore']);
    });

    it('draws a header per client: avatar, name, "12 videos", what they kept, a chevron', async () => {
      const html = await render({ store: byClient });
      const tavo = html.match(/<div[^>]*data-client-id="tavo"[^>]*>.*?<\/button>/s)?.[0] ?? '';
      expect(tavo).toContain('size-7');
      expect(tavo).toContain('<bdi');
      expect(tavo).toContain('עו״ד דוד לוי');
      expect(tavo).toContain('12 videos');
      expect(tavo).toContain('₪480');
      expect(tavo).toContain('min-h-14');
      expect(html).toContain('8 videos');
      expect(html).toContain('6 videos');
    });

    it('opens the first client to begin with, with its newest videos and "and 9 more"', async () => {
      const html = await render({ store: byClient });
      expect(html.match(/<button[^>]*aria-expanded="true"/g)).toHaveLength(1);
      expect(html).toMatch(/data-client-id="tavo".*?aria-expanded="true"/s);
      expect(html).toContain('and 9 more');
      // The three newest of the client, each with where it stands (the board's right-hand text).
      const open = html.match(/data-client-id="tavo".*?and 9 more/s)?.[0] ?? '';
      for (const name of ['מיתוס או אמת 5', 'מיתוס או אמת 4', 'שאלות נפוצות 5']) {
        expect(open).toContain(name);
      }
      expect(open.match(/<span data-paid="" [^>]*>Not paid yet<\/span>/g)).toHaveLength(3);
    });

    it('opens the client the store says, and none when it was closed', async () => {
      const rgm = await render({ store: { ...byClient, clientOpen: 'rgm' } });
      expect(rgm).toMatch(/data-client-id="rgm".*?aria-expanded="true"/s);
      expect(rgm).not.toMatch(/data-client-id="tavo"[^>]*>\s*<button[^>]*aria-expanded="true"/);
      const none = await render({ store: { ...byClient, clientOpen: null } });
      expect(none).not.toContain('aria-expanded="true"');
    });

    it('has no "Show all" button while the clients fit in the first ten', async () => {
      expect(await render({ store: byClient })).not.toContain('phone-money-more');
    });
  });

  describe('the footer', () => {
    it('adds up to the banners: 26 videos ₪1,040, not charged −₪970, Profit ₪70', async () => {
      const html = await render();
      const footer =
        html.match(/data-slot="phone-money-footer".*?<\/div><\/div><\/div>/s)?.[0] ?? '';
      expect(footer).toContain('26 videos delivered');
      expect(footer).toContain('₪1,040');
      expect(footer).toContain('₪1,040 income, nothing bought for a video');
      expect(footer).toContain('Not charged to a video');
      expect(footer).toContain('−₪970');
      expect(footer).toContain('Claude Code ₪900 · ChatGPT ₪70');
      expect(footer).toMatch(/data-footer-profit[^>]*text-\[#4ADE80\][^>]*>₪70</);
      // It is the same box as the rows, below them.
      expect(html.indexOf('phone-money-more')).toBeLessThan(html.indexOf('phone-money-footer'));
    });

    it('turns the Not charged amount red', async () => {
      const html = await render();
      expect(html).toMatch(/data-footer-line="not-charged".*?text-\[#F87171\][^>]*>−₪970</s);
    });
  });

  describe('the Expenses', () => {
    it('has a heading, the board’s line and the "Items | All charges" switch with Items pressed', async () => {
      const html = await render();
      expect(html).toMatch(/<h2[^>]*>Expenses<\/h2>/);
      expect(html).toContain('Every subscription and charge this month.');
      const group =
        html.match(/<div[^>]*aria-label="Show expenses as"[^>]*>.*?<\/div>/s)?.[0] ?? '';
      expect(group).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Items<\/button>/);
      expect(group).toMatch(/<button[^>]*aria-pressed="false"[^>]*>All charges<\/button>/);
    });

    it('lists the items with their amounts to the agora and the total line', async () => {
      const html = await render();
      const exp = html.slice(html.indexOf('phone-exp-h'));
      expect(exp).toContain('Claude Code');
      expect(exp).toContain('Subscription · renews Nov 1');
      expect(exp).toContain('₪899.90');
      expect(exp).toContain('ChatGPT');
      expect(exp).toContain('₪69.90');
      const total =
        exp.match(/data-slot="phone-money-expenses-total"[^>]*>(.*?)<\/div>/s)?.[1] ?? '';
      expect(total).toContain('2 items · total this month');
      expect(total).toContain('₪969.80');
    });

    it('lists every charge by date in All charges, with the total under them', async () => {
      const html = await render({ store: { expensesView: 'charges' } });
      const exp = html.slice(html.indexOf('phone-exp-h'));
      expect(exp).toMatch(/<button[^>]*aria-pressed="true"[^>]*>All charges<\/button>/);
      expect(exp).toContain('Oct 1');
      expect(exp).toContain('Monthly plan');
      expect(exp).toContain('2 charges · total this month');
      expect(exp).toContain('₪969.80');
    });

    it('has no pager and no "Show all" while the rows fit in ten', async () => {
      const html = await render();
      const exp = html.slice(html.indexOf('phone-exp-h'));
      expect(exp).not.toContain('phone-money-more');
      expect(exp).not.toContain('Expense pages');
    });

    it('says "No expenses in October." for a month with none', async () => {
      const base = boardMoney();
      const html = await render({
        data: { ...base, expenses: { ...base.expenses, items: [], charges: [], total: 0 } },
      });
      expect(html).toContain('No expenses in October.');
    });
  });

  describe('the states', () => {
    it('draws three grey cards after the delay while the first answer is on its way', async () => {
      const html = await render({ data: null });
      expect(html.match(/data-skeleton-banner/g)).toHaveLength(3);
      expect(html).toContain('Loading the month…');
      expect(html).not.toContain('data-banner=');
    });

    it('says "Can’t reach the engine." with Try again when the first load failed', async () => {
      const html = await render({ data: null, failed: true });
      expect(html).toContain('Can&#x27;t reach the engine.');
      expect(html).toContain('Try again');
      expect(html).not.toContain('data-skeleton-banner');
    });

    it('keeps the month on screen when a later load fails (the numbers stay)', async () => {
      expect(await render({ failed: true })).toContain('data-banner="income"');
    });

    it('says the engine is being reconnected under the title', async () => {
      const html = await render({ reconnecting: true });
      expect(html).toContain('Reconnecting to the engine…');
      expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('Reconnecting to the engine…'));
    });
  });
});
