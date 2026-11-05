import type { JobDelivery } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob, makeJobDelivery } from '@/data/test-utils';
import {
  deliveredDay,
  deliveredMonth,
  deliveredToday,
  deliveryDetail,
  deliveryMoneyDetail,
  formatPrice,
  monthName,
  paidDay,
  postedDay,
  uploadedOwedText,
} from './delivery-text';

const ready = (delivery: JobDelivery | null) =>
  makeJob({ state: 'ready', placeInLine: null, delivery });

// 20 October 2026 was a Tuesday.
const REEL = { uploadedAt: '2026-10-20T09:30:00.000Z', reelUrl: 'https://x.test/reel/rooftop/' };

describe('deliveryMoneyDetail and uploadedOwedText: where an uploaded job’s money is said', () => {
  const uploaded = ready(makeJobDelivery({ ...REEL, reelPlays: 27_500 }));

  it('deliveryMoneyDetail keeps the money where the row says the plays', () => {
    expect(deliveryMoneyDetail(uploaded, 'UTC')).toBe('Posted Tue 20 Oct · ₪40 not paid');
  });

  it('deliveryMoneyDetail is the row’s line for every other job', () => {
    for (const delivery of [
      makeJobDelivery(),
      makeJobDelivery({ paidOn: '2026-10-23' }),
      makeJobDelivery({ ...REEL, paidOn: '2026-10-23' }),
      { deliveredAt: '2026-10-21T09:00:00.000Z' },
    ]) {
      expect(deliveryMoneyDetail(ready(delivery), 'UTC')).toBe(
        deliveryDetail(ready(delivery), 'UTC'),
      );
    }
    expect(deliveryMoneyDetail(ready(null))).toBeNull();
  });

  it('uploadedOwedText is "₪40 not paid" for an uploaded job, with the real price', () => {
    expect(uploadedOwedText(uploaded)).toBe('₪40 not paid');
    expect(uploadedOwedText(ready(makeJobDelivery({ ...REEL, price: 37.5 })))).toBe(
      '₪37.50 not paid',
    );
  });

  it('uploadedOwedText is nothing for any other job, and for an editor’s', () => {
    expect(uploadedOwedText(ready(makeJobDelivery()))).toBeNull();
    expect(uploadedOwedText(ready(makeJobDelivery({ ...REEL, paidOn: '2026-10-23' })))).toBeNull();
    expect(uploadedOwedText(ready(null))).toBeNull();
    expect(
      uploadedOwedText(ready({ deliveredAt: '2026-10-21T09:00:00.000Z', ...REEL })),
    ).toBeNull();
    expect(
      uploadedOwedText(makeJob({ state: 'failed', delivery: makeJobDelivery(REEL) })),
    ).toBeNull();
  });
});

describe('deliveryDetail: the line of a delivered or paid row', () => {
  it('Delivered: "Delivered 21 Oct · ₪40 not paid"', () => {
    expect(deliveryDetail(ready(makeJobDelivery()), 'UTC')).toBe('Delivered 21 Oct · ₪40 not paid');
  });

  it('Paid: "Paid 23 Oct · ₪40"', () => {
    const paid = makeJobDelivery({ paidOn: '2026-10-23' });
    expect(deliveryDetail(ready(paid), 'UTC')).toBe('Paid 23 Oct · ₪40');
  });

  it('Paid: what was paid for it, when that is not its price ("Paid 23 Oct · ₪0")', () => {
    const free = makeJobDelivery({ paidOn: '2026-10-23', paidAmount: 0 });
    expect(deliveryDetail(ready(free), 'UTC')).toBe('Paid 23 Oct · ₪0');
    const less = makeJobDelivery({ paidOn: '2026-10-23', paidAmount: 32.5 });
    expect(deliveryDetail(ready(less), 'UTC')).toBe('Paid 23 Oct · ₪32.50');
  });

  it('reads the real price of the delivery, not a fixed one', () => {
    const dear = makeJobDelivery({ price: 200 });
    expect(deliveryDetail(ready(dear), 'UTC')).toBe('Delivered 21 Oct · ₪200 not paid');
    expect(deliveryDetail(ready({ ...dear, paidOn: '2026-10-22' }), 'UTC')).toBe(
      'Paid 22 Oct · ₪200',
    );
  });

  it('Uploaded: "Posted Tue 20 Oct · 27.5K plays", the day the reel was posted and its plays', () => {
    const uploaded = makeJobDelivery({ ...REEL, reelPlays: 27_500 });
    expect(deliveryDetail(ready(uploaded), 'UTC')).toBe('Posted Tue 20 Oct · 27.5K plays');
  });

  it('Uploaded: the plays the short way of the Instagram section (980, 18.4K, 1.2M, 1 play, 0)', () => {
    const line = (reelPlays: number) =>
      deliveryDetail(ready(makeJobDelivery({ ...REEL, reelPlays })), 'UTC');
    expect(line(980)).toBe('Posted Tue 20 Oct · 980 plays');
    expect(line(18_400)).toBe('Posted Tue 20 Oct · 18.4K plays');
    expect(line(1_200_000)).toBe('Posted Tue 20 Oct · 1.2M plays');
    expect(line(1)).toBe('Posted Tue 20 Oct · 1 play');
    expect(line(0)).toBe('Posted Tue 20 Oct · 0 plays');
  });

  it('Uploaded: no plays are written for a reel whose plays are not known, and no money either', () => {
    expect(deliveryDetail(ready(makeJobDelivery(REEL)), 'UTC')).toBe('Posted Tue 20 Oct');
  });

  it('Uploaded, for an editor (no money): the same line, plays included', () => {
    const editors = { deliveredAt: '2026-10-21T09:00:00.000Z', ...REEL };
    expect(deliveryDetail(ready({ ...editors, reelPlays: 9_800 }), 'UTC')).toBe(
      'Posted Tue 20 Oct · 9.8K plays',
    );
    expect(deliveryDetail(ready(editors), 'UTC')).toBe('Posted Tue 20 Oct');
  });

  it('Uploaded, a video whose folder was deleted says so first', () => {
    const job = {
      ...ready(makeJobDelivery({ ...REEL, reelPlays: 27_500 })),
      folderDeleted: true,
    };
    expect(deliveryDetail(job, 'UTC')).toBe('Folder deleted · Posted Tue 20 Oct · 27.5K plays');
  });

  it('Paid stays "Paid 23 Oct · ₪40" when a reel is linked to it, plays or not', () => {
    const paid = makeJobDelivery({ ...REEL, reelPlays: 27_500, paidOn: '2026-10-23' });
    expect(deliveryDetail(ready(paid), 'UTC')).toBe('Paid 23 Oct · ₪40');
    expect(deliveryDetail(ready({ ...paid, reelPlays: undefined }), 'UTC')).toBe(
      'Paid 23 Oct · ₪40',
    );
  });

  it('is nothing for an approved job, which keeps the line every ready job has', () => {
    expect(deliveryDetail(ready(null))).toBeNull();
  });

  it('is nothing for a job that left ready, even with the delivery of an earlier run', () => {
    for (const state of ['editing', 'review', 'failed', 'queued'] as const) {
      expect(deliveryDetail(makeJob({ state, delivery: makeJobDelivery() })), state).toBeNull();
    }
  });
});

describe('deliveredDay: the browser’s local day', () => {
  // 21 October 22:30 in New York is already the 22nd in Jerusalem.
  const late = { deliveredAt: '2026-10-22T02:30:00.000Z' };

  it('names the day on the wall clock of the zone', () => {
    expect(deliveredDay(late, 'America/New_York')).toBe('21 Oct');
    expect(deliveredDay(late, 'Asia/Jerusalem')).toBe('22 Oct');
    expect(deliveredDay(late, 'UTC')).toBe('22 Oct');
  });

  it('uses the system zone when none is given', () => {
    const date = new Date(late.deliveredAt);
    expect(deliveredDay(late)).toBe(
      `${date.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]}`,
    );
  });

  it('has no leading zero on the day, and spells out no year', () => {
    expect(deliveredDay({ deliveredAt: '2026-11-05T09:00:00.000Z' }, 'UTC')).toBe('5 Nov');
  });

  it('is empty for a moment that cannot be read', () => {
    expect(deliveredDay({ deliveredAt: 'not a time' }, 'UTC')).toBe('');
  });
});

describe('postedDay: the weekday and the local day the reel was posted', () => {
  it('says "Tue 20 Oct"', () => {
    expect(postedDay(REEL, 'UTC')).toBe('Tue 20 Oct');
  });

  it('names the day on the wall clock of the zone, with the weekday that day had there', () => {
    // 20 October 23:30 in New York is already Wednesday the 21st in Jerusalem.
    const late = { uploadedAt: '2026-10-21T03:30:00.000Z' };
    expect(postedDay(late, 'America/New_York')).toBe('Tue 20 Oct');
    expect(postedDay(late, 'Asia/Jerusalem')).toBe('Wed 21 Oct');
  });

  it('works on the browser’s own calendar without a zone', () => {
    expect(postedDay(REEL)).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  });

  it('is empty for a delivery no reel is linked to, and for a time that cannot be read', () => {
    expect(postedDay({}, 'UTC')).toBe('');
    expect(postedDay({ uploadedAt: 'whenever' }, 'UTC')).toBe('');
  });
});

describe('deliveredToday: the same calendar day as now', () => {
  const sent = { deliveredAt: '2026-10-22T12:10:00.000Z' };

  it('is true on the day of the delivery, and false the next', () => {
    expect(deliveredToday(sent, '2026-10-22T20:00:00.000Z', 'UTC')).toBe(true);
    expect(deliveredToday(sent, '2026-10-23T00:30:00.000Z', 'UTC')).toBe(false);
  });

  it('goes by the wall clock of the zone, not by hours', () => {
    // 22:30 and 23:30 in New York are the 22nd; 02:00 UTC on the 23rd is the 22nd there, too.
    expect(deliveredToday(sent, '2026-10-23T02:00:00.000Z', 'America/New_York')).toBe(true);
    expect(deliveredToday(sent, '2026-10-23T02:00:00.000Z', 'Asia/Jerusalem')).toBe(false);
  });

  it('is false for the same date a year on, and for moments that cannot be read', () => {
    expect(deliveredToday(sent, '2027-10-22T12:10:00.000Z', 'UTC')).toBe(false);
    expect(deliveredToday({ deliveredAt: 'not a time' }, sent.deliveredAt, 'UTC')).toBe(false);
    expect(deliveredToday(sent, 'not a time', 'UTC')).toBe(false);
  });
});

describe('deliveredMonth: the month a delivery counts in', () => {
  it('is the month name on the zone’s wall clock', () => {
    const edge = { deliveredAt: '2026-10-31T23:30:00.000Z' };
    expect(deliveredMonth(edge, 'UTC')).toBe('October');
    expect(deliveredMonth(edge, 'Asia/Jerusalem')).toBe('November');
  });

  it('is English whatever the system locale', () => {
    expect(deliveredMonth({ deliveredAt: '2026-09-15T09:00:00.000Z' }, 'UTC')).toBe('September');
    expect(deliveredMonth({ deliveredAt: '2026-03-15T09:00:00.000Z' }, 'UTC')).toBe('March');
  });
});

describe('monthName: the name of a YYYY-MM month', () => {
  it('is the English name, with no zone to convert', () => {
    expect(monthName('2026-10')).toBe('October');
    expect(monthName('2027-01')).toBe('January');
    expect(monthName('2026-12')).toBe('December');
  });

  it('is empty for a month that is not one', () => {
    expect(monthName('2026-13')).toBe('');
    expect(monthName('')).toBe('');
  });
});

describe('paidDay: a calendar day, with no zone to convert', () => {
  it('writes YYYY-MM-DD as "23 Oct"', () => {
    expect(paidDay('2026-10-23')).toBe('23 Oct');
    expect(paidDay('2026-01-05')).toBe('5 Jan');
    expect(paidDay('2026-12-31')).toBe('31 Dec');
  });
});

describe('formatPrice', () => {
  it.each([
    [40, 'ILS', '₪40'],
    [0, 'ILS', '₪0'],
    [1200, 'ILS', '₪1,200'],
    [37.5, 'ILS', '₪37.50'],
    [25, 'USD', '$25'],
    [30, 'EUR', 'EUR 30'],
  ])('%s %s is %s', (price, currency, text) => {
    expect(formatPrice(price, currency)).toBe(text);
  });
});
