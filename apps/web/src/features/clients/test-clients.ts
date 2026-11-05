// Test data for the Clients pages: the seven clients of the design canvas's Clients board, with the
// jobs the Jobs board gives five of them and one job each for the other two, at the same ages.
// Not imported by the app.

import type { ClientRow, Job } from '@studio/shared';
import type { StateStorage } from 'zustand/middleware';
import { makeJob } from '@/data/test-utils';
import { createClientsUiStore } from '@/stores/clients-ui';
import { createMemoryStorage } from '@/stores/jobs-ui';
import { CANVAS_JOBS, CLIENT_IDS } from '../jobs/test-jobs';

/** Noa Ceramics and Lumen Yoga have a single job each, newer than anything on the Jobs board. */
const EXTRA_JOBS: readonly Job[] = [
  makeJob({
    id: 'j13',
    client: 'Noa Ceramics',
    clientId: CLIENT_IDS['Noa Ceramics'],
    name: 'Kiln opening',
    relPath: 'Noa Ceramics/Kiln opening',
    state: 'arriving',
    placeInLine: null,
    settledAt: null,
    addedAt: '2026-10-20T13:40:00.000Z',
    updatedAt: '2026-10-20T13:40:00.000Z',
  }),
  makeJob({
    id: 'j14',
    client: 'Lumen Yoga',
    clientId: CLIENT_IDS['Lumen Yoga'],
    name: 'Morning flow',
    relPath: 'Lumen Yoga/Morning flow',
    state: 'queued',
    placeInLine: 3,
    addedAt: '2026-10-20T13:22:00.000Z',
    updatedAt: '2026-10-20T13:22:00.000Z',
  }),
];

/** Fourteen jobs of seven clients. */
export const CLIENT_BOARD_JOBS: readonly Job[] = [...CANVAS_JOBS, ...EXTRA_JOBS];

/**
 * The names in the default order: last job, newest first. (The Jobs board's Kova job is newer than
 * the one its Clients board shows, so Kova Coffee sits above טל נכסים here, not below.)
 */
export const CLIENT_DEFAULT_ORDER = [
  'מאפיית הצפון',
  'Noa Ceramics',
  'Arc Fitness',
  'Lumen Yoga',
  'מרפאת מירה',
  'Kova Coffee',
  'טל נכסים',
] as const;

/** A valid client row of `GET /api/clients`: a client with one job unless the overrides say more. */
export function makeClientRow(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    jobs: 1,
    lastJobAt: '2026-10-20T11:02:10.000Z',
    style: { state: 'none', updatedAt: null },
    ...overrides,
  };
}

/** A client folder that holds no job yet, so it has no last job. */
export function makeEmptyClientRow(overrides: Partial<ClientRow> = {}): ClientRow {
  return makeClientRow({ jobs: 0, lastJobAt: null, ...overrides });
}

/**
 * The rows the server would list for these jobs: one per `clientId`, with the job count and the
 * newest `addedAt`, sorted by name. `extra` are more rows, such as clients with no jobs.
 */
export function clientRowsOf(jobs: readonly Job[], extra: readonly ClientRow[] = []): ClientRow[] {
  const rows = new Map<string, ClientRow>();
  for (const job of jobs) {
    const row = rows.get(job.clientId);
    const newest =
      row?.lastJobAt != null && Date.parse(row.lastJobAt) > Date.parse(job.addedAt)
        ? row.lastJobAt
        : job.addedAt;
    rows.set(
      job.clientId,
      makeClientRow({
        clientId: job.clientId,
        client: job.client,
        jobs: (row?.jobs ?? 0) + 1,
        lastJobAt: newest,
      }),
    );
  }
  return [...rows.values(), ...extra].sort((a, b) => a.client.localeCompare(b.client, 'en'));
}

/** The seven clients of the Clients board, as the server lists them. */
export const CLIENT_BOARD_ROWS: readonly ClientRow[] = clientRowsOf(CLIENT_BOARD_JOBS);

/** The rows of `manyClientJobs(count)`, as the server lists them. */
export function manyClientRows(count: number): ClientRow[] {
  return clientRowsOf(manyClientJobs(count));
}

/** `count` clients with one job each, "Client 01" … "Client 40", the last of them the oldest. */
export function manyClientJobs(count: number): Job[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `Client ${String(i + 1).padStart(2, '0')}`;
    const added = new Date(Date.UTC(2026, 9, 20, 13, 42) - i * 60_000).toISOString();
    return makeJob({
      id: `many${i}`,
      client: name,
      clientId: `many${String(i).padStart(8, '0')}`,
      name: 'Promo',
      relPath: `${name}/Promo`,
      addedAt: added,
      updatedAt: added,
    });
  });
}

/**
 * A Clients UI store for server-rendered tests. zustand's `useStore` reads the store's *initial*
 * state when rendering on a server, so a test that changes the state and then renders would see the
 * defaults; this points that snapshot at the current state (see `createTestStore` for the Jobs one).
 */
export function createTestClientsStore(storage: StateStorage = createMemoryStorage()) {
  const store = createClientsUiStore(storage);
  store.getInitialState = () => store.getState();
  return store;
}
