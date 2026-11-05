// The October of the phone's Money boards (MMoney), as the server's answer for tests: 26 videos at
// ₪40 (12 for עו״ד דוד לוי, 8 for RGM, 6 for LAKESHORE; four not paid yet, one archived), nothing
// bought for a video, and the two subscriptions that make the month's expenses ₪969.80.
// Not imported by the app.

import type { MoneyLedgerEntry, MoneyResponse } from '@studio/shared';
import { makeMoneyResponse } from '@/data/test-utils';

/** `value`, or a failed test when it is missing (the tests' way to say "this is there"). */
export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

const TAVO = { client: 'עו״ד דוד לוי', clientId: 'tavo' };
const RGM = { client: 'RGM', clientId: 'rgm' };
const LAKESHORE = { client: 'LAKESHORE', clientId: 'lakeshore' };

/** One of the board's videos: ₪40 income, no cost, delivered on `day` of October at noon (UTC). */
function video(
  id: string,
  name: string,
  who: { client: string; clientId: string },
  day: number,
  paid: string | 'archived' | null,
  reviewMin: number,
): MoneyLedgerEntry {
  return {
    jobId: id,
    name,
    ...who,
    deliveredAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    listedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    paidOn: paid === null || paid === 'archived' ? null : paid,
    archived: paid === 'archived',
    income: 40,
    expenses: 0,
    profit: 40,
    reviewSec: reviewMin * 60,
    charges: [],
  };
}

/** The six newest are the board's own; the rest fill the groups up to 12, 8 and 6 videos. */
export function boardLedger(): MoneyLedgerEntry[] {
  const first = [
    video('j01', 'אדריכלות', LAKESHORE, 22, null, 9),
    video('j02', 'מיתוס או אמת 5', TAVO, 21, null, 5),
    video('j03', 'ראיון עם השחקן', RGM, 19, '2026-10-20', 11),
    video('j04', 'מיתוס או אמת 4', TAVO, 16, null, 4),
    video('j05', 'כללי', LAKESHORE, 13, 'archived', 7),
    video('j06', 'שאלות נפוצות 5', TAVO, 12, null, 6),
  ];
  const rest: MoneyLedgerEntry[] = [];
  const fill = (who: typeof TAVO, count: number, prefix: string) => {
    for (let i = 0; i < count; i += 1) {
      const n = rest.length + 7;
      rest.push(
        video(
          `j${String(n).padStart(2, '0')}`,
          `${prefix} ${i + 1}`,
          who,
          11 - (n % 10),
          '2026-10-12',
          6,
        ),
      );
    }
  };
  fill(TAVO, 9, 'Myth');
  fill(RGM, 7, 'Match');
  fill(LAKESHORE, 4, 'Lobby');
  return [...first, ...rest];
}

/**
 * October 2026 as the board has it: Income ₪1,040 (September ₪880, ₪160 of it not paid yet, 4
 * videos), Expenses ₪969.80 (the same as September), Profit ₪70.20 (September −₪89.80). Override
 * any part.
 */
export function boardMoney(overrides: Partial<MoneyResponse> = {}): MoneyResponse {
  const ledger = boardLedger();
  const base = makeMoneyResponse();
  const charge = (item: string, ils: number) => ({
    date: '2026-10-01',
    item,
    what: 'Monthly plan',
    amountLabel: `₪${ils.toFixed(2)}`,
    ils,
    job: null,
  });
  const claude = charge('Claude Code', 899.9);
  const chatgpt = charge('ChatGPT', 69.9);
  const item = (id: string, name: string, ils: number, one: typeof claude) => ({
    id,
    name,
    kind: 'Subscription' as const,
    billing: 'Monthly · renews Nov 1',
    amountLabel: `₪${ils.toFixed(2)}`,
    ils,
    charges: [one],
    notes: [],
  });
  return makeMoneyResponse({
    month: '2026-10',
    months: ['2026-10', '2026-09'],
    banners: {
      income: {
        value: 1040,
        previous: 880,
        history: [600, 720, 680, 760, 800, 840, 880, 1040],
        unpaid: { value: 160, count: 4 },
      },
      expenses: {
        value: 969.8,
        previous: 969.8,
        history: [969.8, 969.8, 969.8, 969.8, 969.8, 969.8, 969.8, 969.8],
      },
      profit: {
        value: 70.2,
        previous: -89.8,
        history: [-370, -250, -290, -210, -170, -130, -89.8, 70.2],
      },
    },
    ledger,
    subscriptions: [
      { id: 'claude-code', name: 'Claude Code', ils: 899.9 },
      { id: 'chatgpt', name: 'ChatGPT', ils: 69.9 },
    ],
    expenses: {
      ...base.expenses,
      items: [
        item('claude-code', 'Claude Code', 899.9, claude),
        item('chatgpt', 'ChatGPT', 69.9, chatgpt),
      ],
      charges: [claude, chatgpt],
      total: 969.8,
    },
    ...overrides,
  });
}
