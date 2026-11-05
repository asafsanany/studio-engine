import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import {
  allTicked,
  amountText,
  confirmLabel,
  formatTotal,
  initialTicked,
  isPaidOnAllowed,
  type OwedJob,
  owedJobs,
  paidAmounts,
  parseAmount,
  payRows,
  tickedJobs,
  todayLocal,
  toggleAll,
  toggleTicked,
  totalLabel,
  typeAmount,
  videoCount,
} from './pay-list';

const CLIENT = 'client-tavo';

/** A ready job of `clientId`, delivered at 09:00 UTC on `day` (21 Oct is the 21st in every zone). */
function delivered(
  id: string,
  day: string,
  overrides: Partial<Job> = {},
  price = 40,
  currency = 'ILS',
): Job {
  return makeJob({
    id,
    name: `Video ${id}`,
    clientId: CLIENT,
    state: 'ready',
    placeInLine: null,
    delivery: makeJobDelivery({ deliveredAt: `${day}T09:00:00.000Z`, price, currency }),
    ...overrides,
  });
}

const J5 = delivered('j5', '2026-10-21');
const J4 = delivered('j4', '2026-10-16');
const J3 = delivered('j3', '2026-10-12');

describe('owedJobs', () => {
  it('lists the client’s delivered, unpaid videos, newest delivery first', () => {
    // Given oldest first, the list comes out newest first.
    expect(owedJobs([J3, J5, J4], CLIENT).map((job) => job.id)).toEqual(['j5', 'j4', 'j3']);
  });

  it('lists a video with a reel linked to it (Uploaded): it is delivered and not paid', () => {
    const uploaded = delivered('up', '2026-10-18', {
      delivery: makeJobDelivery({
        deliveredAt: '2026-10-18T09:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
        reelUrl: 'https://www.instagram.com/reel/C-up/',
      }),
    });
    expect(owedJobs([J3, uploaded, J5], CLIENT).map((job) => job.id)).toEqual(['j5', 'up', 'j3']);
  });

  it('leaves out a paid video a reel is linked to: it stays Paid', () => {
    const paidAndLinked = delivered('pl', '2026-10-18', {
      delivery: makeJobDelivery({
        deliveredAt: '2026-10-18T09:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
        paidOn: '2026-10-22',
      }),
    });
    expect(owedJobs([paidAndLinked, J5], CLIENT).map((job) => job.id)).toEqual(['j5']);
  });

  it('leaves out an archived uploaded video, as it does any archived one', () => {
    const archived = delivered('au', '2026-10-18', {
      archivedAt: '2026-10-21T10:00:00.000Z',
      delivery: makeJobDelivery({
        deliveredAt: '2026-10-18T09:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
      }),
    });
    expect(owedJobs([archived], CLIENT)).toEqual([]);
  });

  it('leaves out a video whose delivery has no price (an editor’s job: money is the admin’s)', () => {
    const noMoney = delivered('nomoney', '2026-10-16', {
      delivery: { deliveredAt: '2026-10-16T09:00:00.000Z' },
    });
    expect(owedJobs([noMoney, J3], CLIENT).map((job) => job.id)).toEqual(['j3']);
  });

  it('keeps the list’s order for videos delivered at the same moment', () => {
    const a = delivered('a', '2026-10-16');
    const b = delivered('b', '2026-10-16');
    const c = delivered('c', '2026-10-16');
    expect(owedJobs([b, c, a], CLIENT).map((job) => job.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by the moment, not the text, so a delivery with another offset is placed right', () => {
    const early = delivered('early', '2026-10-16', {
      delivery: makeJobDelivery({ deliveredAt: '2026-10-16T08:00:00.000Z' }),
    });
    const late = delivered('late', '2026-10-16', {
      // 10:30 at +03:00 is 07:30 UTC: earlier than 08:00 UTC although the text sorts after it.
      delivery: makeJobDelivery({ deliveredAt: '2026-10-16T10:30:00.000+03:00' }),
    });
    expect(owedJobs([late, early], CLIENT).map((job) => job.id)).toEqual(['early', 'late']);
  });

  it('leaves out other clients’ videos', () => {
    const other = delivered('other', '2026-10-20', { clientId: 'client-rgm' });
    expect(owedJobs([other, J4], CLIENT).map((job) => job.id)).toEqual(['j4']);
  });

  it('leaves out paid videos, approved ones, and one that left ready again (it has no stage)', () => {
    const paid = delivered('paid', '2026-10-20', {
      delivery: makeJobDelivery({ paidOn: '2026-10-22' }),
    });
    const approved = delivered('approved', '2026-10-20', { delivery: null });
    const editing = delivered('editing', '2026-10-20', { state: 'editing' });
    expect(owedJobs([paid, approved, editing, J4], CLIENT).map((job) => job.id)).toEqual(['j4']);
  });

  it('leaves out archived videos: archived means paid already or not needed', () => {
    const archived = delivered('archived', '2026-10-20', {
      archivedAt: '2026-10-21T10:00:00.000Z',
    });
    expect(owedJobs([archived, J4], CLIENT).map((job) => job.id)).toEqual(['j4']);
  });

  it('is empty before the list has loaded, or when the client owes nothing', () => {
    expect(owedJobs(undefined, CLIENT)).toEqual([]);
    expect(owedJobs([J4], 'someone-else')).toEqual([]);
  });

  it('does not change the list it is given', () => {
    const list = [J3, J5, J4];
    owedJobs(list, CLIENT);
    expect(list.map((job) => job.id)).toEqual(['j3', 'j5', 'j4']);
  });
});

describe('the ticks', () => {
  const owed = owedJobs([J5, J4, J3], CLIENT);

  it('start with the video the dialog was opened from', () => {
    expect([...initialTicked(owed, 'j4')]).toEqual(['j4']);
  });

  it('start empty when that video is no longer owed (paid, put back, or never listed)', () => {
    expect([...initialTicked(owed, 'gone')]).toEqual([]);
    expect([...initialTicked([], 'j4')]).toEqual([]);
  });

  it('toggle one video on and off without touching the set they were given', () => {
    const one = initialTicked(owed, 'j4');
    const two = toggleTicked(one, 'j5');
    expect([...two].sort()).toEqual(['j4', 'j5']);
    expect([...one]).toEqual(['j4']);
    expect([...toggleTicked(two, 'j4')]).toEqual(['j5']);
  });

  it('give the ticked videos in the dialog’s order, and ignore a tick for a video no longer owed', () => {
    const ticks = new Set(['j3', 'gone', 'j5']);
    expect(tickedJobs(owed, ticks).map((job) => job.id)).toEqual(['j5', 'j3']);
  });

  it('are all ticked only when every owed video is, and never with nothing owed', () => {
    expect(allTicked(owed, new Set(['j5', 'j4']))).toBe(false);
    expect(allTicked(owed, new Set(['j5', 'j4', 'j3']))).toBe(true);
    // A tick for a video that left the list does not make up for one that is not ticked.
    expect(allTicked(owed, new Set(['j5', 'j4', 'gone']))).toBe(false);
    expect(allTicked([], new Set())).toBe(false);
  });

  it('Select all ticks every owed video, and Clear (when all are ticked) unticks them', () => {
    const all = toggleAll(owed, initialTicked(owed, 'j4'));
    expect([...all].sort()).toEqual(['j3', 'j4', 'j5']);
    expect([...toggleAll(owed, all)]).toEqual([]);
    expect([...toggleAll(owed, new Set())].sort()).toEqual(['j3', 'j4', 'j5']);
  });
});

describe('formatTotal', () => {
  const at = (price: number, currency = 'ILS') => ({
    delivery: makeJobDelivery({ price, currency }),
  });

  it('adds up the prices the videos were delivered at', () => {
    expect(formatTotal([at(40), at(40), at(40)])).toBe('₪120');
    expect(formatTotal([at(40), at(200)])).toBe('₪240');
  });

  it('keeps cents, and drops the float noise of adding them', () => {
    expect(formatTotal([at(37.5), at(37.5)])).toBe('₪75');
    expect(formatTotal([at(0.1), at(0.2)])).toBe('₪0.30');
    expect(formatTotal([at(12.34), at(0.01)])).toBe('₪12.35');
  });

  it('does not add one currency to another: each has its own sum, in the order first seen', () => {
    expect(formatTotal([at(40), at(25, 'USD'), at(40), at(5, 'USD')])).toBe('₪80 + $30');
  });

  it('is empty for no videos', () => {
    expect(formatTotal([])).toBe('');
  });

  it('adds up what was paid for a paid video, not its price', () => {
    const paid = (price: number, paidAmount: number) => ({
      delivery: makeJobDelivery({ price, paidOn: '2026-10-23', paidAmount }),
    });
    expect(formatTotal([paid(40, 0), paid(40, 25), at(40)])).toBe('₪65');
  });
});

describe('the amount paid for each video', () => {
  const [j5, j4] = owedJobs([J5, J4], CLIENT) as [OwedJob, OwedJob];

  it('starts as the price the video was delivered at', () => {
    expect(amountText(40)).toBe('40');
    expect(amountText(37.5)).toBe('37.5');
    expect(amountText(0.1 + 0.2)).toBe('0.3');
    expect(paidAmounts([j5, j4], new Map())).toEqual({ j5: 40, j4: 40 });
  });

  it('reads whole amounts and up to two decimals, 0 included', () => {
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount(' 40 ')).toBe(40);
    expect(parseAmount('37.5')).toBe(37.5);
    expect(parseAmount('37,50')).toBe(37.5);
  });

  it('refuses what is not an amount', () => {
    for (const text of ['', ' ', '-5', 'abc', '4o', '1.234', '₪40', '1,000.00', '.5']) {
      expect(parseAmount(text)).toBeNull();
    }
  });

  it('pays each ticked video what was typed for it', () => {
    const typed = typeAmount(typeAmount(new Map(), 'j5', '0'), 'j4', '25');
    expect(paidAmounts([j5, j4], typed)).toEqual({ j5: 0, j4: 25 });
    // An amount typed for a video that is not ticked is not in the payment.
    expect(paidAmounts([j4], typed)).toEqual({ j4: 25 });
  });

  it('cannot be sent while a ticked video holds no amount', () => {
    const typed = typeAmount(new Map(), 'j5', '');
    expect(paidAmounts([j5, j4], typed)).toBeNull();
    expect(paidAmounts([j4], typed)).toEqual({ j4: 40 });
  });

  it('is what the footer adds up', () => {
    const typed = typeAmount(new Map(), 'j5', '0');
    expect(totalLabel([j5], typed)).toBe('1 video · ₪0');
    expect(totalLabel([j5, j4], typed)).toBe('2 videos · ₪40');
    // A field that holds no amount counts as nothing.
    expect(totalLabel([j5, j4], typeAmount(typed, 'j5', 'x'))).toBe('2 videos · ₪40');
  });

  it('is what each row shows, with the sign of its currency', () => {
    const typed = typeAmount(new Map(), 'j5', '0');
    const [first, second] = payRows([j5, j4], new Set(['j5']), 'UTC', typed);
    expect(first).toMatchObject({ amount: '0', amountValid: true, sign: '₪', price: '₪40' });
    expect(second).toMatchObject({ amount: '40', amountValid: true });
    expect(payRows([j5], new Set(), 'UTC', typeAmount(typed, 'j5', '-'))[0]?.amountValid).toBe(
      false,
    );
  });
});

describe('the words', () => {
  const [one, two] = owedJobs([J5, J4], CLIENT);
  const pair = [one, two] as OwedJob[];

  it('count videos in the singular and the plural', () => {
    expect(videoCount(1)).toBe('1 video');
    expect(videoCount(2)).toBe('2 videos');
    expect(videoCount(0)).toBe('0 videos');
  });

  it('give the footer total: Nothing ticked, 1 video, 2 videos', () => {
    expect(totalLabel([])).toBe('Nothing ticked');
    expect(totalLabel(pair.slice(0, 1))).toBe('1 video · ₪40');
    expect(totalLabel(pair)).toBe('2 videos · ₪80');
  });

  it('give the primary button: Mark paid for one (or none), Mark 2 paid for more', () => {
    expect(confirmLabel(0)).toBe('Mark paid');
    expect(confirmLabel(1)).toBe('Mark paid');
    expect(confirmLabel(2)).toBe('Mark 2 paid');
    expect(confirmLabel(12)).toBe('Mark 12 paid');
  });
});

describe('todayLocal', () => {
  it('is the calendar day on the browser’s own clock, with the month and day padded', () => {
    expect(todayLocal(new Date(2026, 0, 5, 9, 0))).toBe('2026-01-05');
    expect(todayLocal(new Date(2026, 9, 21, 23, 59, 59))).toBe('2026-10-21');
    expect(todayLocal(new Date(2026, 11, 31, 0, 0, 0))).toBe('2026-12-31');
  });

  it('is today by default', () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isPaidOnAllowed', () => {
  it('allows today and any earlier day', () => {
    expect(isPaidOnAllowed('2026-10-21', '2026-10-21')).toBe(true);
    expect(isPaidOnAllowed('2026-10-14', '2026-10-21')).toBe(true);
    expect(isPaidOnAllowed('2025-12-31', '2026-01-01')).toBe(true);
  });

  it('refuses a future day', () => {
    expect(isPaidOnAllowed('2026-10-22', '2026-10-21')).toBe(false);
    expect(isPaidOnAllowed('2027-01-01', '2026-10-21')).toBe(false);
  });

  it('refuses a day that is empty or not a whole YYYY-MM-DD (a date being typed)', () => {
    expect(isPaidOnAllowed('', '2026-10-21')).toBe(false);
    expect(isPaidOnAllowed('2026-10', '2026-10-21')).toBe(false);
    expect(isPaidOnAllowed('21/10/2026', '2026-10-21')).toBe(false);
  });
});

describe('payRows', () => {
  it('has a row per owed video: its name, the day it was delivered, its price and whether it is ticked', () => {
    const owed = owedJobs([J5, J4], CLIENT);
    expect(payRows(owed, new Set(['j4']), 'UTC')).toEqual([
      {
        id: 'j5',
        name: 'Video j5',
        delivered: '21 Oct',
        price: '₪40',
        sign: '₪',
        amount: '40',
        amountValid: true,
        checked: false,
        folderDeleted: false,
      },
      {
        id: 'j4',
        name: 'Video j4',
        delivered: '16 Oct',
        price: '₪40',
        sign: '₪',
        amount: '40',
        amountValid: true,
        checked: true,
        folderDeleted: false,
      },
    ]);
  });

  it('writes the price the video was delivered at, in its own currency', () => {
    const owed = owedJobs([delivered('usd', '2026-10-16', {}, 25, 'USD')], CLIENT);
    expect(payRows(owed, new Set(), 'UTC')[0]).toMatchObject({
      price: '$25',
      sign: '$',
      amount: '25',
    });
  });

  it('reads the day on the clock it is given (a late-evening delivery is the next day in Israel)', () => {
    const late = delivered('late', '2026-10-16', {
      delivery: makeJobDelivery({ deliveredAt: '2026-10-16T22:30:00.000Z' }),
    });
    const owed = owedJobs([late], CLIENT);
    expect(payRows(owed, new Set(), 'UTC')[0]?.delivered).toBe('16 Oct');
    expect(payRows(owed, new Set(), 'Asia/Jerusalem')[0]?.delivered).toBe('17 Oct');
  });
});
