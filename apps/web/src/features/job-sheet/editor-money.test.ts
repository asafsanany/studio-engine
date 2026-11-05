import { type Job, withoutJobMoney } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJobDelivery } from '@/data/test-utils';
import { deliveryDetail } from '../jobs/delivery-text';
import { detailRows, phoneDetailRows } from './sheet-details';
import { historyRows } from './sheet-history';
import { sheetNow } from './sheet-now';
import { jobSheetJobs, jobSheetNow } from './test-fixtures';

// An editor's jobs come without the price, currency and pay date of a delivery (money is the
// admin's alone): the screens say that the video was delivered, and nothing about money.

const UTC = 'UTC';
const now = jobSheetNow.delivered;
const wholeDelivered: Job = jobSheetJobs.delivered;
const wholePaid: Job = {
  ...jobSheetJobs.delivered,
  delivery: makeJobDelivery({ paidOn: '2026-10-23' }),
};
const delivered = withoutJobMoney(wholeDelivered);
const paid = withoutJobMoney(wholePaid);
const MONEY = /₪|\bprice\b|not paid|paid|Money/i;

describe('a delivered video without its money', () => {
  it('has the row detail of a delivered video and no price', () => {
    expect(deliveryDetail(delivered, UTC)).toBe('Delivered 21 Oct');
    expect(deliveryDetail(paid, UTC)).toBe('Delivered 21 Oct');
    // The admin's line is unchanged.
    expect(deliveryDetail(wholeDelivered, UTC)).toBe('Delivered 21 Oct · ₪40 not paid');
  });

  it('has no Money row in the sheet, and still says when it was added', () => {
    const labels = detailRows(delivered, now, UTC).map((row) => row.label);
    expect(labels).not.toContain('Money');
    expect(labels).toContain('Added');
    expect(detailRows(wholeDelivered, now, UTC).map((row) => row.label)).toContain('Money');
  });

  it('has no Price and no Paid row on the phone', () => {
    const rows = phoneDetailRows(paid, now, UTC) ?? [];
    expect(rows.map((row) => row.label)).toContain('Delivered');
    expect(rows.map((row) => row.label)).not.toContain('Price');
    expect(rows.map((row) => row.label)).not.toContain('Paid');
  });

  it('says it was sent, without the price or "isn’t paid yet"', () => {
    const sentence = sheetNow(delivered, [], now, { timeZone: UTC }).sentence;
    expect(sentence).toBe(`Sent to ${delivered.client} on 21 Oct.`);
    expect(sheetNow(paid, [], now, { timeZone: UTC }).sentence).toBe(sentence);
    expect(sheetNow(wholeDelivered, [], now, { timeZone: UTC }).sentence).toContain('₪40');
  });

  it('has "Marked delivered" in its history, with no price and no "Marked paid"', () => {
    const rows = historyRows({ job: paid, runs: [], notes: [] }, now, UTC);
    const texts = rows.map((row) => row.text);
    expect(texts).toContain('Marked delivered');
    expect(texts.join('\n')).not.toMatch(MONEY);
  });
});
