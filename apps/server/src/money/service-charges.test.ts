import type { UsageEntry } from '@studio/shared';
import { computeMoney, moneyFileSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { InstagramRepository } from '../db/instagram-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import { createServiceChargeReader } from './service-charges.js';

const money = moneyFileSchema.parse({
  subscriptions: [
    {
      id: 'elevenlabs',
      name: 'ElevenLabs (Starter)',
      amount: 6,
      currency: 'USD',
      every: 'month',
      day: 20,
      since: '2026-10-20',
    },
  ],
});

const job = { id: 'job1', relPath: 'Pinewood/97 Window Ad' };

describe('createServiceChargeReader', () => {
  it('reads the jobs, their Generate rows and the usage log and works out the charges', async () => {
    const read = createServiceChargeReader({
      jobs: { getAll: () => [job] as never },
      generate: {
        listAll: () =>
          [
            {
              jobId: 'job1',
              spendUsd: 3.128,
              elevenlabsChars: 0,
              updatedAt: '2026-10-26T00:12:00+02:00',
            },
          ] as never,
      },
      usage: () => [],
    });

    const charges = await read({ money, timeZone: 'Asia/Jerusalem' });

    expect(charges).toEqual([
      {
        date: '2026-10-26',
        item: 'Higgsfield',
        what: 'Pictures and clips',
        amount: 3.128,
        currency: 'USD',
        job: 'Pinewood/97 Window Ad',
      },
    ]);
  });

  it('counts a usage log that cannot be read as empty, so the rest still shows', async () => {
    const read = createServiceChargeReader({
      jobs: { getAll: () => [job] as never },
      generate: {
        listAll: () =>
          [
            {
              jobId: 'job1',
              spendUsd: 1,
              elevenlabsChars: 0,
              updatedAt: '2026-10-26T00:12:00+02:00',
            },
          ] as never,
      },
      usage: (): UsageEntry[] => {
        throw new Error('torn');
      },
    });

    const charges = await read({ money, timeZone: 'Asia/Jerusalem' });

    expect(charges.map((charge) => charge.item)).toEqual(['Higgsfield']);
  });
});

describe('createServiceChargeReader: Instagram scans', () => {
  const opened: StudioDb[] = [];
  afterEach(() => {
    for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  });

  const MON = Date.parse('2026-10-26T06:00:00+02:00');
  const reader = (instagram: InstagramRepository | undefined, clients: object[] = []) =>
    createServiceChargeReader({
      jobs: { getAll: () => clients as never },
      generate: { listAll: () => [] },
      usage: () => [],
      ...(instagram === undefined ? {} : { instagram }),
    });

  function repo() {
    const db = memoryDb();
    opened.push(db);
    return new InstagramRepository(db, { clock: fakeClock() });
  }

  it("makes each scan's recorded cost an Apify payment dated its day, with no job, failed ones too", async () => {
    const instagram = repo();
    instagram.upsertAccount({ clientId: 'c-falcon', client: 'Falcon FPV', handle: 'falcon.fpv' });
    const ok = instagram.startScan({ clientId: 'c-falcon', handle: 'falcon.fpv', startedAt: MON });
    instagram.finishScan(ok.id, { outcome: 'ok', costUsd: 0.1042, apifyRunIds: ['r1', 'r2'] });
    const failed = instagram.startScan({
      clientId: 'c-falcon',
      handle: 'falcon.fpv',
      startedAt: MON + 7 * 24 * 60 * 60 * 1000,
    });
    instagram.finishScan(failed.id, { outcome: 'failed', error: 'timeout', costUsd: 0.04 });
    const free = instagram.startScan({
      clientId: 'c-falcon',
      handle: 'falcon.fpv',
      startedAt: MON + 1,
    });
    instagram.finishScan(free.id, { outcome: 'no-token' });

    const charges = await reader(instagram)({ money, timeZone: 'Asia/Jerusalem' });

    expect(charges).toEqual([
      {
        date: '2026-10-26',
        item: 'Apify',
        what: 'Instagram scan · Falcon FPV',
        amount: 0.1042,
        currency: 'USD',
      },
      {
        date: '2026-11-02',
        item: 'Apify',
        what: 'Instagram scan · Falcon FPV',
        amount: 0.04,
        currency: 'USD',
      },
    ]);
  });

  it('names a client whose account was removed by its jobs, else by the scanned handle', async () => {
    const instagram = repo();
    for (const [clientId, handle] of [
      ['c-falcon', 'falcon.fpv'],
      ['c-gone', 'gone.handle'],
    ] as const) {
      instagram.upsertAccount({ clientId, client: 'x', handle });
      const scan = instagram.startScan({ clientId, handle, startedAt: MON });
      instagram.finishScan(scan.id, { outcome: 'ok', costUsd: 0.1 });
      instagram.removeAccount(clientId);
    }

    const charges = await reader(instagram, [{ clientId: 'c-falcon', client: 'Falcon FPV' }])({
      money,
      timeZone: 'Asia/Jerusalem',
    });

    expect(charges.map((charge) => charge.what)).toEqual([
      'Instagram scan · Falcon FPV',
      'Instagram scan · @gone.handle',
    ]);
  });

  it('has no Apify payment when the engine reads no Instagram', async () => {
    expect(await reader(undefined)({ money, timeZone: 'Asia/Jerusalem' })).toEqual([]);
  });

  it("reaches the Money page as the month's Apify item, in no job's expenses", async () => {
    const instagram = repo();
    instagram.upsertAccount({ clientId: 'c-falcon', client: 'Falcon FPV', handle: 'falcon.fpv' });
    const scan = instagram.startScan({
      clientId: 'c-falcon',
      handle: 'falcon.fpv',
      startedAt: MON,
    });
    instagram.finishScan(scan.id, { outcome: 'ok', costUsd: 0.1 });

    const noPlans = moneyFileSchema.parse({});
    const serviceCharges = await reader(instagram)({ money: noPlans, timeZone: 'Asia/Jerusalem' });
    const answer = computeMoney({
      deliveries: [],
      money: noPlans,
      month: '2026-10',
      timeZone: 'Asia/Jerusalem',
      now: Date.parse('2026-10-27T10:00:00+02:00'),
      serviceCharges,
    });

    expect(answer.expenses.items).toMatchObject([
      { name: 'Apify', kind: 'Per use', amountLabel: '1 use', ils: 0.37 },
    ]);
    expect(answer.expenses.total).toBe(answer.banners.expenses.value);
    expect(answer.ledger).toEqual([]);
  });
});
