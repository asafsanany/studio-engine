// The board's October for the phone Money specs: the answer of `/api/money` with 26 videos at ₪40, 4
// of them not paid yet, and two subscriptions (Claude Code ₪899.90 and ChatGPT ₪69.90), as the
// design boards MMoney and MMoneyWarn draw it. `stubMoney` answers the page's requests with it, so a
// spec sees the board's numbers whatever the engine holds.

import type { Page } from '@playwright/test';

const TAVO = 'עו״ד דוד לוי';
const RGM = 'RGM';

/** One of the board's videos. */
export function video(
  id: string,
  name: string,
  client: string,
  clientId: string,
  month: string,
  day: number,
  paid: string | 'archived' | null,
  reviewMin: number,
) {
  return {
    jobId: id,
    name,
    client,
    clientId,
    deliveredAt: `${month}-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    listedAt: `${month}-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    paidOn: paid === null || paid === 'archived' ? null : `${month}-${paid}`,
    archived: paid === 'archived',
    income: 40,
    expenses: 0,
    profit: 40,
    reviewSec: reviewMin * 60,
    charges: [],
  };
}

/** The server's answer for `month`, with the board's numbers: 26 videos at ₪40 and two subscriptions. */
export function boardAnswer(
  month: string,
  moneyFile = { status: 'ok', issue: null as string | null },
) {
  const v = (...args: [string, string, string, string, number, string | null, number]) =>
    video(args[0], args[1], args[2], args[3], month, args[4], args[5], args[6]);
  const ledger = [
    v('j01', 'אדריכלות', 'LAKESHORE', 'lakeshore', 22, null, 9),
    v('j02', 'מיתוס או אמת 5', TAVO, 'tavo', 21, null, 5),
    v('j03', 'ראיון עם השחקן', RGM, 'rgm', 19, '20', 11),
    v('j04', 'מיתוס או אמת 4', TAVO, 'tavo', 16, null, 4),
    v('j05', 'כללי', 'LAKESHORE', 'lakeshore', 13, 'archived', 7),
    v('j06', 'שאלות נפוצות 5', TAVO, 'tavo', 12, null, 6),
  ];
  const fill = (client: string, clientId: string, count: number, prefix: string) => {
    for (let i = 0; i < count; i += 1) {
      const n = ledger.length + 1;
      ledger.push(
        v(
          `j${String(n).padStart(2, '0')}`,
          `${prefix} ${i + 1}`,
          client,
          clientId,
          11 - (n % 10),
          '12',
          6,
        ),
      );
    }
  };
  fill(TAVO, 'tavo', 9, 'Myth');
  fill(RGM, 'rgm', 7, 'Match');
  fill('LAKESHORE', 'lakeshore', 4, 'Lobby');
  const charge = (item: string, ils: number) => ({
    date: `${month}-01`,
    item,
    what: 'Monthly plan',
    amountLabel: `₪${ils.toFixed(2)}`,
    ils,
    job: null,
  });
  const claude = charge('Claude Code', 899.9);
  const chatgpt = charge('ChatGPT', 69.9);
  const item = (id: string, name: string, ils: number, one: ReturnType<typeof charge>) => ({
    id,
    name,
    kind: 'Subscription',
    billing: 'Monthly · renews Nov 1',
    amountLabel: `₪${ils.toFixed(2)}`,
    ils,
    charges: [one],
    notes: [] as string[],
  });
  return {
    month,
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
      items: [
        item('claude-code', 'Claude Code', 899.9, claude),
        item('chatgpt', 'ChatGPT', 69.9, chatgpt),
      ],
      charges: [claude, chatgpt],
      total: 969.8,
      usdToIls: 3.7,
    },
    moneyFile,
  };
}

/** Answers `/api/money` with the board's numbers; returns the months it was asked for, in order. */
export async function stubMoney(
  page: Page,
  moneyFile = { status: 'ok', issue: null as string | null },
): Promise<string[]> {
  const asked: string[] = [];
  await page.route(
    (url) => url.pathname === '/api/money',
    async (route) => {
      const month = new URL(route.request().url()).searchParams.get('month') ?? '2026-10';
      asked.push(month);
      await route.fulfill({ json: boardAnswer(month, moneyFile) });
    },
  );
  return asked;
}
