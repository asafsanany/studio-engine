import { describe, expect, it } from 'vitest';
import { makeMoneyResponse } from '@/data/test-utils';
import { bannerViews } from '../money/banner-view';
import { expensesFooter } from '../money/expenses-view';
import { formatIls, formatIlsAgorot } from '../money/format';
import {
  DEFAULT_LEDGER_SORT,
  jobDetail,
  ledgerPage,
  monthSummary,
  sortLedger,
} from '../money/ledger-view';
import {
  GROUP_PREVIEW_ROWS,
  groupPreview,
  moneyFileLine,
  PHONE_MONEY_DEFAULTS_TEXT,
  PHONE_MONEY_LAST_GOOD_TEXT,
  PHONE_MONEY_ROWS,
  paidLine,
  phoneBanners,
  phoneExpenses,
  phoneFooter,
  phoneJobDetail,
  phoneJobRow,
  phoneLedger,
  showAllLabel,
  videoCountText,
} from './phone-money';
import { boardLedger, boardMoney, must } from './test-money';

const UTC = 'UTC';

describe('videoCountText', () => {
  it('says video in the singular and videos otherwise', () => {
    expect(videoCountText(1)).toBe('1 video');
    expect(videoCountText(0)).toBe('0 videos');
    expect(videoCountText(26)).toBe('26 videos');
  });
});

describe('phoneBanners: the numbers are the Mac’s', () => {
  const data = boardMoney();
  const mac = bannerViews(data.month, data.banners, data.ledger);
  const phone = phoneBanners(data);

  it('has the same three banners in the same order, with the same amounts, pills, lines and sparklines', () => {
    expect(phone.map((b) => b.kind)).toEqual(['income', 'expenses', 'profit']);
    for (const [i, banner] of phone.entries()) {
      const { description: _phone, ...rest } = banner;
      const { description: _mac, ...macRest } = mac[i] ?? banner;
      expect(rest).toEqual(macRest);
    }
  });

  it('prints the board’s October: ₪1,040 +18%, ₪970 and ₪70 with the change since September', () => {
    const by = (kind: string) => phone.find((b) => b.kind === kind);
    expect(by('income')).toMatchObject({
      value: '₪1,040',
      percent: '+18%',
      delta: '+₪160 vs September (₪880)',
      tone: 'good',
    });
    expect(by('expenses')).toMatchObject({
      value: '₪970',
      percent: '0%',
      delta: 'Same as September',
      tone: 'flat',
    });
    expect(by('profit')).toMatchObject({
      value: '₪70',
      percent: '+178%',
      delta: '+₪160 vs September (−₪90)',
      tone: 'good',
    });
  });

  it('adds "₪160 not paid yet · 4 videos" to Income alone', () => {
    expect(phone[0]?.unpaid).toEqual({ amount: '₪160', text: 'not paid yet · 4 videos' });
    expect(phone[1]?.unpaid).toBeNull();
    expect(phone[2]?.unpaid).toBeNull();
  });

  it('counts videos where the Mac counts jobs: "26 videos at ₪40"', () => {
    expect(phone[0]?.description).toBe('26 videos at ₪40');
    expect(mac[0]?.description).toBe('26 jobs at ₪40');
  });

  it('says "No videos delivered" for a month with none, and only the count for mixed prices', () => {
    const none = boardMoney({ ledger: [] });
    expect(phoneBanners(none)[0]?.description).toBe('No videos delivered');
    const mixed = boardMoney({
      ledger: [
        { ...must(boardLedger()[0]), income: 40 },
        { ...must(boardLedger()[1]), income: 55 },
      ],
    });
    expect(phoneBanners(mixed)[0]?.description).toBe('2 videos');
  });
});

describe('moneyFileLine', () => {
  it('is nothing while money.json is fine', () => {
    expect(moneyFileLine({ status: 'ok', issue: null })).toBeNull();
  });

  it('is the board’s line for the last good numbers, and its own for the defaults', () => {
    expect(moneyFileLine({ status: 'last-good', issue: 'pricePerJob: expected number' })).toBe(
      PHONE_MONEY_LAST_GOOD_TEXT,
    );
    expect(PHONE_MONEY_LAST_GOOD_TEXT).toBe(
      'money.json has a mistake, so this page shows the last good numbers. Run pnpm run doctor on the Mac to see it.',
    );
    expect(moneyFileLine({ status: 'defaults', issue: null })).toBe(PHONE_MONEY_DEFAULTS_TEXT);
  });
});

describe('paidLine', () => {
  it('says Paid with the day, Archived, or Not paid yet (the only amber one)', () => {
    expect(paidLine({ paidOn: '2026-10-22', archived: false })).toEqual({
      text: 'Paid Oct 22',
      owed: false,
    });
    expect(paidLine({ paidOn: null, archived: true })).toEqual({ text: 'Archived', owed: false });
    expect(paidLine({ paidOn: null, archived: false })).toEqual({
      text: 'Not paid yet',
      owed: true,
    });
  });

  it('says Paid for a job that was paid and then archived', () => {
    expect(paidLine({ paidOn: '2026-10-09', archived: true }).text).toBe('Paid Oct 9');
  });
});

describe('phoneJobRow', () => {
  it('words a video as the board does: the name, "delivered Oct 21", Not paid yet, ₪40', () => {
    const entry = boardLedger().find((e) => e.jobId === 'j02');
    expect(entry).toBeDefined();
    expect(phoneJobRow(must(entry), UTC)).toEqual({
      jobId: 'j02',
      name: 'מיתוס או אמת 5',
      client: 'עו״ד דוד לוי',
      delivered: 'delivered Oct 21',
      paid: { text: 'Not paid yet', owed: true },
      profit: '₪40',
    });
  });

  it('says a video that is not delivered yet is not delivered yet, with nothing owed', () => {
    const entry = {
      ...must(boardLedger()[0]),
      deliveredAt: null,
      income: 0,
      expenses: 11.57,
      profit: -11.57,
    };
    expect(phoneJobRow(entry, UTC)).toMatchObject({
      delivered: 'not delivered yet',
      paid: { text: '', owed: false },
    });
    expect(phoneJobDetail(entry, UTC)[0]?.notes).toEqual([
      'Not delivered yet: no income until it is',
    ]);
  });

  it('shows the profit the way the Mac’s table does, in whole shekels', () => {
    const entry = { ...must(boardLedger()[0]), income: 200, expenses: 15, profit: 185 };
    expect(phoneJobRow(entry, UTC).profit).toBe(formatIls(185));
  });
});

describe('phoneJobDetail: the details are the Mac’s', () => {
  const entry = must(boardLedger().find((e) => e.jobId === 'j01'));

  it('has the Mac’s four columns, each with the Mac’s total', () => {
    const rows = phoneJobDetail(entry, UTC);
    const columns = jobDetail(entry, UTC);
    expect(rows.map((r) => r.id)).toEqual(['income', 'expenses', 'profit', 'time']);
    expect(rows.map((r) => r.title)).toEqual(columns.map((c) => c.title));
    expect(rows[0]?.value).toBe(columns[0]?.total.value);
    // The Profit is the Mac's amount without a needless ".00" (the board's ₪40).
    expect(rows[2]?.value).toBe(columns[2]?.total.value.replace(/\.00$/, ''));
    expect(rows[3]?.value).toBe(columns[3]?.total.value);
    expect(rows.map((r) => r.tone)).toEqual(columns.map((c) => c.total.tone));
  });

  it('reads as the board: price, delivery and payment on one line, then margin and review time', () => {
    expect(phoneJobDetail(entry, UTC)).toEqual([
      {
        id: 'income',
        title: 'Income',
        notes: ['Price ₪40 · delivered Oct 22 · Not paid yet'],
        value: '₪40',
        tone: 'green',
      },
      {
        id: 'expenses',
        title: 'Expenses',
        notes: ['Nothing paid for this video'],
        value: '—',
        tone: 'grey',
      },
      { id: 'profit', title: 'Profit', notes: ['Margin 100%'], value: '₪40', tone: 'plain' },
      {
        id: 'time',
        title: 'Your time',
        notes: ['Review and notes · 9 min'],
        value: '₪267/h',
        tone: 'plain',
      },
    ]);
  });

  it('reads a profit of whole shekels as ₪40 and keeps the agorot of one that is not whole', () => {
    const profitOf = (profit: number) =>
      phoneJobDetail({ ...entry, profit }, UTC).find((r) => r.id === 'profit')?.value;
    expect(profitOf(40)).toBe('₪40');
    expect(profitOf(39.5)).toBe('₪39.50');
    expect(profitOf(-12)).toBe('−₪12');
    expect(profitOf(-12.34)).toBe('−₪12.34');
    expect(profitOf(0)).toBe('₪0');
  });

  it('lists what a video was charged for, with the Mac’s notes and the Mac’s total', () => {
    const charged = must(makeMoneyResponse().ledger[0]);
    const rows = phoneJobDetail(charged, UTC);
    const expenses = rows.find((r) => r.id === 'expenses');
    expect(expenses?.notes).toEqual(['Stock footage · 2 clips at ₪7.50 · ₪15.00']);
    expect(expenses?.value).toBe(formatIlsAgorot(15));
    expect(expenses?.tone).toBe('red');
  });

  it('says a paid video was paid, an archived one Archived, and no review time yet', () => {
    const paid = must(boardLedger().find((e) => e.jobId === 'j03'));
    expect(phoneJobDetail(paid, UTC)[0]?.notes).toEqual([
      'Price ₪40 · delivered Oct 19 · Paid Oct 20',
    ]);
    const archived = must(boardLedger().find((e) => e.jobId === 'j05'));
    expect(phoneJobDetail(archived, UTC)[0]?.notes[0]).toMatch(/· Archived$/);
    const noReview = { ...entry, reviewSec: 0 };
    expect(phoneJobDetail(noReview, UTC)[3]).toMatchObject({
      notes: ['No review time yet'],
      value: '—',
    });
  });
});

describe('showAllLabel', () => {
  const videos = { one: 'video', many: 'videos' };

  it('is nothing while the list fits in its first ten rows', () => {
    expect(showAllLabel(PHONE_MONEY_ROWS, videos, false)).toBeNull();
    expect(showAllLabel(3, videos, true)).toBeNull();
  });

  it('says "Show all 26 videos", and then "Show fewer"', () => {
    expect(showAllLabel(26, videos, false)).toBe('Show all 26 videos');
    expect(showAllLabel(11, videos, false)).toBe('Show all 11 videos');
    expect(showAllLabel(26, videos, true)).toBe('Show fewer');
  });
});

describe('phoneLedger: the Mac’s order, cut after the first ten', () => {
  const entries = boardLedger();

  it('lists the first ten videos newest delivery first, as the Mac’s table does', () => {
    const view = phoneLedger(entries, { grouping: 'job', expanded: false });
    expect(view.grouping).toBe('job');
    if (view.grouping !== 'job') return;
    expect(view.total).toBe(26);
    expect(view.rows).toHaveLength(10);
    expect(view.rows.map((e) => e.jobId)).toEqual(
      sortLedger(entries, DEFAULT_LEDGER_SORT)
        .slice(0, 10)
        .map((e) => e.jobId),
    );
    expect(view.rows.slice(0, 3).map((e) => e.jobId)).toEqual(['j01', 'j02', 'j03']);
    expect(view.more).toBe('Show all 26 videos');
  });

  it('lists every video once expanded, and the button turns into "Show fewer"', () => {
    const view = phoneLedger(entries, { grouping: 'job', expanded: true });
    if (view.grouping !== 'job') throw new Error('expected jobs');
    expect(view.rows).toHaveLength(26);
    expect(view.more).toBe('Show fewer');
  });

  it('groups by client the way the Mac does, the client who kept the most first', () => {
    const view = phoneLedger(entries, { grouping: 'client', expanded: false });
    if (view.grouping !== 'client') throw new Error('expected groups');
    const mac = ledgerPage(entries, {
      grouping: 'client',
      sort: DEFAULT_LEDGER_SORT,
      page: 0,
      pageSize: 10,
    });
    if (mac.grouping !== 'client') throw new Error('expected groups');
    expect(view.groups).toEqual(mac.groups);
    expect(view.groups.map((g) => [g.client, g.jobs.length, g.profit])).toEqual([
      ['עו״ד דוד לוי', 12, 480],
      ['RGM', 8, 320],
      ['LAKESHORE', 6, 240],
    ]);
    // Three clients fit in the first ten rows: no button.
    expect(view.more).toBeNull();
    expect(view.total).toBe(3);
  });

  it('cuts a long client list after ten and says "Show all 12 clients"', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...must(boardLedger()[0]),
      jobId: `x${i}`,
      client: `Client ${i}`,
      clientId: `c${i}`,
    }));
    const view = phoneLedger(many, { grouping: 'client', expanded: false });
    if (view.grouping !== 'client') throw new Error('expected groups');
    expect(view.groups).toHaveLength(10);
    expect(view.more).toBe('Show all 12 clients');
  });

  it('is empty for a month with no video', () => {
    const view = phoneLedger([], { grouping: 'job', expanded: false });
    expect(view).toMatchObject({ grouping: 'job', total: 0, rows: [], more: null });
  });
});

describe('groupPreview', () => {
  const view = phoneLedger(boardLedger(), { grouping: 'client', expanded: false });
  const groups = view.grouping === 'client' ? view.groups : [];

  it('lists a client’s three newest videos and counts the rest: "and 9 more"', () => {
    const tavo = must(groups.find((g) => g.clientId === 'tavo'));
    const preview = groupPreview(tavo);
    expect(preview.rows).toHaveLength(GROUP_PREVIEW_ROWS);
    expect(preview.rows.map((e) => e.jobId)).toEqual(tavo.jobs.slice(0, 3).map((e) => e.jobId));
    expect(preview.more).toBe('and 9 more');
  });

  it('has no "more" line for a client with three videos or fewer', () => {
    const first = must(groups[0]);
    const small = { ...first, jobs: first.jobs.slice(0, 3) };
    expect(groupPreview(small)).toMatchObject({ more: null });
    expect(groupPreview(small).rows).toHaveLength(3);
  });
});

describe('phoneFooter: it adds up to the banners', () => {
  const data = boardMoney();

  it('has the videos, what is not charged to a video, and the Profit banner’s amount', () => {
    expect(phoneFooter(data)).toEqual({
      lines: [
        {
          id: 'jobs',
          label: '26 videos delivered',
          value: '₪1,040',
          tone: 'plain',
          note: '₪1,040 income, nothing bought for a video',
        },
        {
          id: 'not-charged',
          label: 'Not charged to a video',
          value: '−₪970',
          tone: 'red',
          note: 'Claude Code ₪900 · ChatGPT ₪70',
        },
      ],
      profit: { value: '₪70', tone: 'good' },
    });
  });

  it('ends on the Profit banner’s amount, and its lines add up to it', () => {
    const footer = must(phoneFooter(data));
    const banners = phoneBanners(data);
    expect(footer.profit.value).toBe(banners.find((b) => b.kind === 'profit')?.value);
    const summary = monthSummary(data);
    expect(footer.profit.value).toBe(formatIls(summary.total.profit));
    // The two lines above, to the shekel, are the Profit the footer ends on.
    const [jobs, notCharged] = footer.lines;
    const whole = (text: string | undefined) =>
      Number((text ?? '').replace('−', '-').replace(/[₪,]/g, ''));
    expect(whole(jobs?.value) + whole(notCharged?.value)).toBe(whole(footer.profit.value));
  });

  it('says what was bought for a video when something was', () => {
    const charged = makeMoneyResponse();
    const footer = must(phoneFooter(charged));
    expect(footer.lines[0]).toMatchObject({
      id: 'jobs',
      label: '3 videos delivered',
      note: '₪600 income, ₪15.00 bought for videos',
    });
  });

  it('turns red with the Profit banner when the month lost money', () => {
    const lost = boardMoney({
      banners: {
        ...boardMoney().banners,
        profit: { value: -89.8, previous: 70.2, history: [70.2, -89.8] },
      },
    });
    expect(phoneFooter(lost)?.profit).toEqual({ value: '−₪90', tone: 'bad' });
  });

  it('is nothing for a month with nothing to add up', () => {
    const empty = boardMoney({
      ledger: [],
      subscriptions: [],
      banners: {
        income: { value: 0, previous: 0, history: [0], unpaid: { value: 0, count: 0 } },
        expenses: { value: 0, previous: 0, history: [0] },
        profit: { value: 0, previous: 0, history: [0] },
      },
    });
    expect(phoneFooter(empty)).toBeNull();
  });
});

describe('phoneExpenses: the rows and the total are the Mac’s', () => {
  const { expenses } = boardMoney();

  it('lists the items with their kind and billing, the amount to the agora', () => {
    const list = phoneExpenses(expenses, { view: 'items', expanded: false, month: '2026-10' });
    expect(list.rows.map((r) => [r.name, r.sub, r.ils, r.orig])).toEqual([
      ['Claude Code', 'Subscription · renews Nov 1', '₪899.90', ''],
      ['ChatGPT', 'Subscription · renews Nov 1', '₪69.90', ''],
    ]);
    expect(list.more).toBeNull();
    expect(list.empty).toBeNull();
  });

  it('leaves "Monthly" out of an item’s billing, as the board does, and keeps any other cadence', () => {
    const [first] = expenses.items;
    const only = (billing: string) =>
      phoneExpenses(
        { ...expenses, items: [{ ...must(first), billing }] },
        { view: 'items', expanded: false, month: '2026-10' },
      ).rows[0]?.sub;
    expect(only('Monthly · renews Nov 1')).toBe('Subscription · renews Nov 1');
    expect(only('Monthly · last charge Oct 12')).toBe('Subscription · last charge Oct 12');
    expect(only('Yearly · renews Mar 5, 2027')).toBe('Subscription · Yearly · renews Mar 5, 2027');
    expect(only('Per use')).toBe('Subscription · Per use');
  });

  it('ends on the Mac’s footer: the count and the month’s total', () => {
    const items = phoneExpenses(expenses, { view: 'items', expanded: false, month: '2026-10' });
    expect(items.footer).toEqual({
      label: expensesFooter('items', 2, expenses.total).label,
      amount: expensesFooter('items', 2, expenses.total).amount,
    });
    expect(items.footer).toEqual({ label: '2 items · total this month', amount: '₪969.80' });
    const charges = phoneExpenses(expenses, { view: 'charges', expanded: false, month: '2026-10' });
    expect(charges.footer).toEqual({ label: '2 charges · total this month', amount: '₪969.80' });
  });

  it('lists the charges by date, each with its own date and what it was for', () => {
    const list = phoneExpenses(expenses, { view: 'charges', expanded: false, month: '2026-10' });
    expect(list.rows.map((r) => [r.name, r.charge?.date, r.charge?.what])).toEqual([
      ['Claude Code', '2026-10-01', 'Monthly plan'],
      ['ChatGPT', '2026-10-01', 'Monthly plan'],
    ]);
    expect(list.rows.every((r) => r.sub === null)).toBe(true);
  });

  it('shows the amount as paid under the shekels when it was another currency', () => {
    const usd = makeMoneyResponse().expenses;
    const list = phoneExpenses(usd, { view: 'items', expanded: false, month: '2026-10' });
    expect(list.rows[0]).toMatchObject({ ils: '₪740.00', orig: '$200.00' });
  });

  it('cuts a long list after ten and says "Show all 12 charges", then "Show fewer"', () => {
    const charge = must(expenses.charges[0]);
    const many = {
      ...expenses,
      charges: Array.from({ length: 12 }, (_, i) => ({ ...charge, date: `2026-10-${10 + i}` })),
    };
    const cut = phoneExpenses(many, { view: 'charges', expanded: false, month: '2026-10' });
    expect(cut.rows).toHaveLength(10);
    expect(cut.more).toBe('Show all 12 charges');
    expect(cut.footer.label).toBe('12 charges · total this month');
    const all = phoneExpenses(many, { view: 'charges', expanded: true, month: '2026-10' });
    expect(all.rows).toHaveLength(12);
    expect(all.more).toBe('Show fewer');
  });

  it('says "No expenses in October." for a month with none', () => {
    const none = { ...expenses, items: [], charges: [], total: 0 };
    const list = phoneExpenses(none, { view: 'items', expanded: false, month: '2026-10' });
    expect(list.empty).toBe('No expenses in October.');
    expect(list.rows).toEqual([]);
  });
});
