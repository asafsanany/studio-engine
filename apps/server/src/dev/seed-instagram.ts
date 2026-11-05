// The dev fixture of Clients × Instagram (IG13): what `pnpm seed:canvas --instagram` adds to the
// design-QA app so the client page, the Clients list and the Jobs page can be compared with the
// boards CLPage, CLStates (S1 to S10) and CLList (L1), and walked through by hand.
//
//   Falcon FPV        the board's sample Instagram, read by the real scanner's mapping over the fake
//                   scanner's answers (apps/server/src/instagram/sample-accounts.ts): 13 weekly scans
//                   (3 Aug to 26 Oct, 10,550 to 12,480 followers), 22 reels, "working together since 1
//                   Aug". Three delivered videos: Granite and Rooftop Run are linked to their reels (so
//                   they are Uploaded), Orchard crunch is Delivered and not linked
//   Flaky Studio    an account whose scan of Mon 19 Oct worked and whose scan of Mon 26 Oct failed:
//                   S3's "The scan of Mon 26 Oct failed. The numbers are from Mon 19 Oct."
//   Venezia         a private account (S3: "The account is private"), one job
//   Elixir           no Instagram yet (S8, and L1's "No Instagram yet" row), one job
//
// The routes are the real ones (clients, Instagram, link, delivery) over the seed's database. Scan
// now, Save and scan and a handle typed into the dialog all work, answered by the fake scanner with
// each run taking `scanSeconds` (default 4): falcon.fpv, flaky.studio (works once, then fails),
// venezia.studio (private), credit.out (Apify's credit is used up), no.key (no Apify key), natgeo and
// any other name (no such account). The weekly check is not started, so nothing scans by itself.
//
// The clock is the boards': Mon 26 Oct 2026, 06:30 UTC, half an hour after the scan whose numbers
// the boards show. Open the page in UTC to read the days as drawn.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerEvent } from '@studio/shared';
import { ClientFolders } from '../clients/client-folders.js';
import { findClient } from '../clients/lookup.js';
import {
  ClientStyleRepository,
  DeliveryRepository,
  InstagramRepository,
  type JobRepository,
  type StudioDb,
} from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { readClientInstagramSummary } from '../instagram/client-instagram.js';
import { createFakeInstagramScanner } from '../instagram/fake-scanner.js';
import {
  BOARD_ANCHOR,
  FALCON_HISTORY_SCANS,
  sampleInstagramFixtures,
} from '../instagram/sample-accounts.js';
import { createInstagramScanQueue, type InstagramScanQueue } from '../instagram/scan-queue.js';
import type { InstagramScanner } from '../instagram/scanner.js';
import type { ClientsRouteOptions } from '../routes/clients.js';
import type { DeliveryRouteOptions } from '../routes/deliveries.js';
import type { InstagramRouteOptions } from '../routes/instagram.js';
import type { CanvasJobSpec } from './seed-canvas.js';

/** The moment the Instagram boards are drawn at, in UTC: half an hour after Monday's scan. */
export const INSTAGRAM_NOW = '2026-10-26T06:30:00.000Z';

const MB = 1_000_000;
const WEEK_MS = 7 * 86_400_000;

export const FALCON = 'Falcon FPV';
export const FLAKY = 'Flaky Studio';
export const PRIVATE_CLIENT = 'Venezia';
export const NO_ACCOUNT = 'Elixir';

/** The seed's jobs: all finished (Approved), the delivered ones with the day the boards give. */
export const INSTAGRAM_JOB_SPECS: readonly CanvasJobSpec[] = [
  job('ig-granite', FALCON, 'Granite', '2026-10-22', { deliveredAt: '2026-10-23T09:00:00.000Z' }),
  job('ig-orchard', FALCON, 'Orchard crunch', '2026-10-20', {
    deliveredAt: '2026-10-21T09:00:00.000Z',
  }),
  job('ig-rooftop', FALCON, 'Rooftop Run', '2026-10-18', {
    deliveredAt: '2026-10-19T09:00:00.000Z',
  }),
  job('ig-flaky', FLAKY, 'Launch teaser', '2026-10-17', {
    deliveredAt: '2026-10-18T09:00:00.000Z',
  }),
  job('ig-private', PRIVATE_CLIENT, 'Tasting night', '2026-10-14', {
    deliveredAt: '2026-10-15T09:00:00.000Z',
    paidOn: '2026-10-20T09:00:00.000Z',
  }),
  job('ig-none', NO_ACCOUNT, 'Product reel', '2026-10-23'),
];

function job(
  id: string,
  client: string,
  name: string,
  day: string,
  delivery?: CanvasJobSpec['delivery'],
): CanvasJobSpec {
  return {
    id,
    client,
    name,
    state: 'ready',
    inputs: [4, 1, 0, 0],
    sizeBytes: 800 * MB,
    addedAt: `${day}T08:00:00.000Z`,
    updatedAt: `${day}T09:00:00.000Z`,
    step: 8,
    output: { durationSec: 30, width: 1080, height: 1920, sizeBytes: 40 * MB },
    ...(delivery === undefined ? {} : { delivery }),
  };
}

export interface InstagramSeedOptions {
  db: StudioDb;
  /** The seed's folder: the pictures go to <dir>/instagram/photos/. */
  dir: string;
  inboxPath: string;
  exportsDir: string;
  jobs: JobRepository;
  bus: EventBus;
  /** The seed's clock. */
  clock: () => Date;
  /** Seconds each of a live scan's two runs takes (default 4: long enough to look at "Reading…"). */
  scanSeconds?: number;
  /** Seed no account and no link: the switch on with nothing read (`--empty`). */
  empty?: boolean;
  /** The Monday 06:00 UTC of the last weekly scan. Default: the boards' (`BOARD_ANCHOR`). */
  anchor?: number;
  /** More client folders, for jobs seeded beside the Instagram ones (`--demo`). */
  moreClients?: readonly string[];
  /** What Mark delivered does. Default: nothing, the delivered jobs are there already. */
  recordDelivery?: DeliveryRouteOptions['recordDelivery'];
}

/** What the app needs besides the jobs: the route options and the repository the job sheet reads. */
export interface InstagramSeed {
  repo: InstagramRepository;
  scanner: InstagramScanner;
  queue: InstagramScanQueue;
  clients: ClientsRouteOptions;
  instagramRoutes: InstagramRouteOptions;
  delivery: DeliveryRouteOptions;
}

/**
 * Builds the Instagram side of the seed: the repository, the fake scanner and its queue, the clients
 * and delivery routes' options, and (unless `empty`) the history: the accounts, their scans, and the
 * two links. The jobs and their deliveries are already in the database ({@link INSTAGRAM_JOB_SPECS}).
 */
export async function createInstagramSeed(options: InstagramSeedOptions): Promise<InstagramSeed> {
  const { db, dir, inboxPath, exportsDir, jobs, bus, clock } = options;
  const timeZone = 'UTC';
  const anchor = options.anchor ?? Date.parse(BOARD_ANCHOR);
  /** The Monday 06:00 UTC of the `week`th weekly scan (on the board 0 is 3 Aug, 12 is 26 Oct). */
  const mondayOf = (week: number): number => anchor - (FALCON_HISTORY_SCANS - 1 - week) * WEEK_MS;

  // The history is written at the boards' Mondays, so the repository and the scanner follow `at`
  // until it is done and the seed's own clock after.
  let at: number | null = null;
  const seedClock = (): Date => (at === null ? clock() : new Date(at));
  const repo = new InstagramRepository(db, { clock: seedClock });
  let seeding = true;
  const scanner = createFakeInstagramScanner({
    instagram: repo,
    dataDir: dir,
    clock: seedClock,
    fixtures: sampleInstagramFixtures({ anchor: new Date(anchor), history: true }),
    delayMs: () => (seeding ? 0 : Math.round((options.scanSeconds ?? 4) * 1000)),
  });

  const clients = [
    ...new Set([FALCON, FLAKY, PRIVATE_CLIENT, NO_ACCOUNT, ...(options.moreClients ?? [])]),
  ];
  const folders = new ClientFolders(bus);
  folders.seed(clients);
  for (const client of clients) await mkdir(join(inboxPath, client), { recursive: true });
  const clientStyles = new ClientStyleRepository(db, { clock });

  if (options.empty !== true) {
    const account = (client: string, handle: string, since: string | null, addedAt: number) =>
      repo.upsertAccount({ clientId: clientIdFor(client), client, handle, since, addedAt });
    const scan = async (client: string, handle: string, when: number) => {
      at = when;
      await scanner.scan(clientIdFor(client), handle);
    };

    // Falcon FPV: the board's sample, weekly since 3 Aug.
    const since = anchor - (Date.parse(BOARD_ANCHOR) - Date.parse('2026-08-01'));
    account(
      FALCON,
      'falcon.fpv',
      new Date(since).toISOString().slice(0, 10),
      mondayOf(0) - 3_600_000,
    );
    for (let week = 0; week < FALCON_HISTORY_SCANS; week += 1) {
      await scan(FALCON, 'falcon.fpv', mondayOf(week));
    }
    // Flaky Studio: last Monday's scan worked, today's did not.
    account(FLAKY, 'flaky.studio', null, mondayOf(FALCON_HISTORY_SCANS - 2) - 3_600_000);
    await scan(FLAKY, 'flaky.studio', mondayOf(FALCON_HISTORY_SCANS - 2));
    await scan(FLAKY, 'flaky.studio', mondayOf(FALCON_HISTORY_SCANS - 1));
    // The private account: one scan, that found it private.
    account(PRIVATE_CLIENT, 'venezia.studio', null, mondayOf(FALCON_HISTORY_SCANS - 1) - 3_600_000);
    await scan(PRIVATE_CLIENT, 'venezia.studio', mondayOf(FALCON_HISTORY_SCANS - 1));

    // Two of Falcon's delivered videos are linked to the reels they became, by hand as on the board.
    at = anchor + (Date.parse(INSTAGRAM_NOW) - Date.parse(BOARD_ANCHOR)) - 3_600_000;
    const falcon = clientIdFor(FALCON);
    const reelOf = (caption: string) => {
      const reel = repo.listReels(falcon).find((candidate) => candidate.caption === caption);
      if (reel === undefined) throw new Error(`the sample reel "${caption}" is missing`);
      return reel.shortcode;
    };
    repo.linkReel(reelOf('Granite Fiber, one take through the warehouse'), 'ig-granite');
    repo.linkReel(reelOf('Chasing the train at 120 km/h'), 'ig-rooftop');
  }
  at = null;
  seeding = false;

  const queue = createInstagramScanQueue({
    scanner,
    instagram: repo,
    activeClients: () => null,
    clientExists: (clientId) => findClient(clientId, { jobs, folders, clientStyles }) !== null,
    publish: (event: ServerEvent) => bus.publish(event),
    clock,
    timeZone,
  });

  const publishJob: DeliveryRouteOptions['onJobChanged'] = (changed) =>
    bus.publish({ type: 'job.upsert', job: changed });
  return {
    repo,
    scanner,
    queue,
    clients: {
      jobs,
      clientStyles,
      folders,
      inboxPath,
      exportsDir,
      openFolder: async () => {},
      instagram: {
        summary: (clientId: string) =>
          readClientInstagramSummary(repo, clientId, { now: clock().getTime(), timeZone }),
      },
    },
    instagramRoutes: {
      clients: { jobs, folders, clientStyles },
      instagram: { repo, clock, timeZone: () => timeZone },
      scans: queue,
      dataDir: dir,
      publish: (event: ServerEvent) => bus.publish(event),
      link: {
        jobs,
        instagram: repo,
        onJobChanged: publishJob,
        onClientInstagramChanged: (clientId: string) =>
          bus.publish({ type: 'client-instagram', clientId }),
      },
    },
    delivery: {
      jobs,
      deliveries: new DeliveryRepository(db),
      // Mark delivered is not part of the boards' seed: the delivered jobs are there already.
      recordDelivery: options.recordDelivery ?? (() => false),
      onJobChanged: publishJob,
      onMoneyChanged: () => bus.publish({ type: 'money.changed' }),
    },
  };
}
