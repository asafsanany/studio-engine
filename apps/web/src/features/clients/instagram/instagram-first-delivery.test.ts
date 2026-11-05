import { describe, expect, it } from 'vitest';
import { firstDeliveryDay } from './instagram-first-delivery';

const OPTIONS = { timeZone: 'Asia/Jerusalem' };

const job = (clientId: string, deliveredAt: string | null) => ({
  clientId,
  delivery:
    deliveredAt === null
      ? null
      : { deliveredAt, price: 40, currency: 'ILS' as const, paidOn: null, paidAmount: null },
});

describe('firstDeliveryDay', () => {
  it('is the day of the client’s earliest delivery', () => {
    const jobs = [
      job('falcon', '2026-10-19T12:00:00.000Z'),
      job('falcon', '2026-10-12T12:00:00.000Z'),
      job('falcon', '2026-10-25T12:00:00.000Z'),
    ];
    expect(firstDeliveryDay(jobs, 'falcon', OPTIONS)).toBe('2026-10-12');
  });

  it('counts only the client’s own jobs, and only the delivered ones', () => {
    const jobs = [
      job('other', '2026-08-01T12:00:00.000Z'),
      job('falcon', null),
      job('falcon', '2026-10-19T12:00:00.000Z'),
    ];
    expect(firstDeliveryDay(jobs, 'falcon', OPTIONS)).toBe('2026-10-19');
  });

  it('writes the day in the viewer’s time zone', () => {
    const jobs = [job('falcon', '2026-10-11T22:30:00.000Z')];
    expect(firstDeliveryDay(jobs, 'falcon', { timeZone: 'Asia/Jerusalem' })).toBe('2026-10-12');
    expect(firstDeliveryDay(jobs, 'falcon', { timeZone: 'UTC' })).toBe('2026-10-11');
  });

  it('is null for a client with no delivery, and while the job list is not known', () => {
    expect(firstDeliveryDay([job('falcon', null)], 'falcon', OPTIONS)).toBeNull();
    expect(firstDeliveryDay([], 'falcon', OPTIONS)).toBeNull();
    expect(firstDeliveryDay(undefined, 'falcon', OPTIONS)).toBeNull();
  });
});
