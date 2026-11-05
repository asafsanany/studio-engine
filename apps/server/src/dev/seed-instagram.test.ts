import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClientInstagram,
  type ClientListResponse,
  clientInstagramSchema,
  type Job,
} from '@studio/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instagramPhotoFor } from '../clients/paths.js';
import { clientIdFor } from '../inbox/scan.js';
import { startCanvasServer } from './seed-canvas.js';
import {
  FALCON,
  FLAKY,
  INSTAGRAM_JOB_SPECS,
  INSTAGRAM_NOW,
  NO_ACCOUNT,
  PRIVATE_CLIENT,
} from './seed-instagram.js';

// `pnpm seed:canvas --instagram`: the Clients × Instagram boards (CLPage, CLStates, CLList) as a
// running app: Falcon FPV's sample Instagram through the fake scanner, two linked reels, a delivered
// video that is not linked, a failed scan, a private account and a client with none.

const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function boot(options: Parameters<typeof startCanvasServer>[0] = {}) {
  const webDist = await mkdtemp(join(tmpdir(), 'seed-web-'));
  await writeFile(join(webDist, 'index.html'), '<!doctype html>');
  stops.push(() => rm(webDist, { recursive: true, force: true }));
  const server = await startCanvasServer({ webDist, instagram: true, scanSeconds: 0, ...options });
  stops.push(server.stop);
  const send = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> => {
    const response = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as T };
  };
  const page = async (client: string): Promise<ClientInstagram> =>
    clientInstagramSchema.parse(
      (await send<unknown>('GET', `/clients/${clientIdFor(client)}/instagram`)).json,
    );
  return { server, send, page };
}

/** Waits until the client's scan is done (the queue answers 202 at once; the page says `scanning`). */
async function settled(read: () => Promise<ClientInstagram>): Promise<ClientInstagram> {
  for (let tries = 0; tries < 100; tries += 1) {
    const data = await read();
    if (!data.scanning) return data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the scan never ended');
}

describe('the Clients × Instagram boards (--instagram)', () => {
  let shared: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => {
    shared = await boot();
  }, 60_000);

  it('turns the switch on for this app only, with the boards’ Monday for a clock', async () => {
    const health = await fetch(`${shared.server.url}/api/health`);
    expect(await health.json()).toMatchObject({ instagram: true });
    // The scan of Mon 26 Oct 06:00 is the latest one, half an hour before the clock.
    const falcon = await shared.page(FALCON);
    expect(falcon.lastScan?.finishedAt).toBe('2026-10-26T06:00:00.000Z');
    expect(falcon.nextScanAt).toBe('2026-11-02T06:00:00.000Z');
    expect(INSTAGRAM_NOW).toBe('2026-10-26T06:30:00.000Z');
  });

  it('has the six jobs: Falcon’s three delivered ones, two linked (Uploaded) and one not (Delivered)', async () => {
    const jobs = shared.server.jobs.getAll();
    expect(jobs).toHaveLength(INSTAGRAM_JOB_SPECS.length);
    const byName = new Map(jobs.map((job) => [job.name, job]));
    const granite = byName.get('Granite') as Job;
    const rooftop = byName.get('Rooftop Run') as Job;
    const orchard = byName.get('Orchard crunch') as Job;
    expect(granite.delivery?.uploadedAt).toBe('2026-10-25T19:40:00.000Z');
    expect(granite.delivery?.reelUrl).toMatch(/^https:\/\/www\.instagram\.com\/reel\//);
    expect(rooftop.delivery?.uploadedAt).toBe('2026-10-20T20:05:00.000Z');
    expect(orchard.delivery).not.toBeNull();
    expect(orchard.delivery?.uploadedAt).toBeUndefined();
    expect(byName.get('Product reel')?.delivery).toBeNull();
  });

  it('gives Falcon FPV the board’s Instagram: 13 weekly scans, 22 reels, 2 ours', async () => {
    const falcon = await shared.page(FALCON);
    expect(falcon.account).toMatchObject({
      handle: 'falcon.fpv',
      fullName: 'Falcon FPV',
      since: '2026-08-01',
      private: false,
    });
    expect(falcon.lastScan).toMatchObject({ outcome: 'ok', followers: 12_480, reelsRead: 22 });
    expect(falcon.numbers?.tiles.followers.line).toHaveLength(13);
    expect(falcon.numbers?.tiles.followers).toMatchObject({
      now: 12_480,
      thisWeek: 312,
      sinceUs: 1_930,
    });
    expect(falcon.reels).toHaveLength(22);
    expect(falcon.reels.filter((reel) => reel.job !== null).map((reel) => reel.job?.name)).toEqual([
      'Granite',
      'Rooftop Run',
    ]);
    // Orchard crunch is delivered and no reel links it: the Link to job list has it.
    expect(falcon.linkableJobs.map((job) => job.name)).toEqual(['Orchard crunch']);
    // Its picture is there for the avatar.
    const photo = await fetch(`${shared.server.url}/api/clients/${clientIdFor(FALCON)}/photo`);
    expect(photo.status).toBe(200);
    await expect(
      readFile(instagramPhotoFor(shared.server.dir, clientIdFor(FALCON))),
    ).resolves.toBeDefined();
  });

  it('shows a failed scan over the older numbers, a private account and a client with none', async () => {
    const flaky = await shared.page(FLAKY);
    expect(flaky.lastScan).toMatchObject({ outcome: 'failed', error: "Instagram didn't answer" });
    expect(flaky.numbers).not.toBeNull();
    const privateOne = await shared.page(PRIVATE_CLIENT);
    expect(privateOne.lastScan).toMatchObject({ outcome: 'private' });
    expect(privateOne.account?.private).toBe(true);
    const none = await shared.page(NO_ACCOUNT);
    expect(none.account).toBeNull();
    const list = (await shared.send<ClientListResponse>('GET', '/clients')).json;
    expect(list.map((row) => [row.client, row.instagram?.handle ?? null])).toEqual([
      [NO_ACCOUNT, null],
      [FALCON, 'falcon.fpv'],
      [FLAKY, 'flaky.studio'],
      [PRIVATE_CLIENT, 'venezia.studio'],
    ]);
  });

  it('links and unlinks by hand: Orchard crunch turns Uploaded and Delivered again', async () => {
    const falcon = await shared.page(FALCON);
    const reel = falcon.reels.find(
      (candidate) => candidate.caption === 'Behind the goggles: my setup',
    );
    expect(reel).toBeDefined();
    const orchard = shared.server.jobs.getAll().find((job) => job.name === 'Orchard crunch') as Job;

    const linked = await shared.send<{ status: number }>(
      'POST',
      `/instagram/reels/${reel?.shortcode}/link`,
      { jobId: orchard.id },
    );
    expect(linked.status).toBe(200);
    expect(shared.server.jobs.get(orchard.id)?.delivery?.uploadedAt).toBeDefined();
    expect((await shared.page(FALCON)).linkableJobs).toEqual([]);

    const unlinked = await shared.send('DELETE', `/instagram/reels/${reel?.shortcode}/link`);
    expect(unlinked.status).toBe(200);
    expect(shared.server.jobs.get(orchard.id)?.delivery?.uploadedAt).toBeUndefined();
  });

  it('answers a handle typed in the dialog with the fake scanner, and Scan now with a new scan', async () => {
    // A client with none gets the first scan of a sample account that is not there.
    const id = clientIdFor(NO_ACCOUNT);
    const saved = await shared.send('PUT', `/clients/${id}/instagram`, {
      handle: '@credit.out',
      since: null,
    });
    expect(saved.status).toBe(200);
    const out = await settled(() => shared.page(NO_ACCOUNT));
    expect(out.lastScan).toMatchObject({ outcome: 'no-credit' });
    await shared.send('DELETE', `/clients/${id}/instagram`);

    const before = (await shared.page(FALCON)).lastScan?.finishedAt;
    const again = await shared.send('POST', `/clients/${clientIdFor(FALCON)}/instagram/scan`);
    expect(again.status).toBe(202);
    const after = await settled(() => shared.page(FALCON));
    expect(after.lastScan?.finishedAt).not.toBe(before);
    // The 14th scan: 12 followers more than the board's 12,480.
    expect(after.lastScan?.followers).toBe(12_492);
  });

  it('keeps the other seed options out: it seeds its own rows', async () => {
    await expect(startCanvasServer({ instagram: true, review: true })).rejects.toThrow(
      /--instagram seeds its own rows/,
    );
  });
});
