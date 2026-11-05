import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteClientResponseSchema, type Job, type ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ClientFolders } from '../clients/client-folders.js';
import { instagramPhotoFor } from '../clients/paths.js';
import {
  ClientStyleRepository,
  DeliveryRepository,
  InstagramRepository,
  JobRepository,
  SeriesRepository,
  type StudioDb,
} from '../db/index.js';
import { fakeClock, idFor, makeScan, memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { TeamService } from '../team/team-service.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// DELETE /api/clients/:clientId over the real repositories (in memory), the real list of client
// folders and a temp inbox, exports, data folder, logs and home (for its Trash).

const opened: StudioDb[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const PINEWOOD = clientIdFor('Pinewood');
const LAKESHORE = clientIdFor('LAKESHORE');

async function setup(
  options: {
    inUse?: (job: Job) => string | null;
    instagramBusy?: (clientId: string) => boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'studio-client-delete-'));
  temps.push(root);
  const inboxPath = join(root, 'inbox');
  const exportsDir = join(inboxPath, '_Exports');
  const dataDir = join(root, 'data');
  const logsDir = join(root, 'logs');
  const home = join(root, 'home');
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const clientStyles = new ClientStyleRepository(db, { clock });
  const series = new SeriesRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const instagram = new InstagramRepository(db, { clock });
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const folders = new ClientFolders(bus);
  const team = new TeamService(join(dataDir, 'team.json'));
  const registered = new Set(['Pinewood', 'LAKESHORE']);
  const registry = {
    has: (name: string) => registered.has(name),
    add: async (name: string) => {
      registered.add(name);
    },
    remove: async (name: string) => {
      registered.delete(name);
    },
  };

  // Pinewood: a ready job with its export and log, a style folder, a history, a client log.
  await mkdir(join(inboxPath, 'Pinewood', 'Ad 6'), { recursive: true });
  await writeFile(join(inboxPath, 'Pinewood', 'Ad 6', 'raw.mp4'), 'raw');
  await mkdir(join(inboxPath, 'Pinewood', '_Style'), { recursive: true });
  await writeFile(join(inboxPath, 'Pinewood', '_Style', 'style.md'), '# style');
  await mkdir(join(inboxPath, 'LAKESHORE', 'Promo'), { recursive: true });
  await mkdir(join(exportsDir, 'Pinewood'), { recursive: true });
  await writeFile(join(exportsDir, 'Pinewood', 'Ad 6.mp4'), 'export');
  await mkdir(join(dataDir, 'clients', PINEWOOD, 'history'), { recursive: true });
  await writeFile(join(dataDir, 'clients', PINEWOOD, 'history', '1.md'), '# v1');
  await mkdir(join(logsDir, 'clients'), { recursive: true });
  await writeFile(join(logsDir, 'clients', `${PINEWOOD}.log`), 'client log');
  folders.seed(['LAKESHORE', 'Pinewood']);

  const { job } = jobs.upsertFromScan(makeScan('Pinewood', 'Ad 6'));
  jobs.applyTransition(job.id, { type: 'SETTLED' });
  jobs.applyTransition(job.id, { type: 'START' });
  const ready = jobs.applyTransition(job.id, {
    type: 'SUCCEED',
    output: {
      fileName: 'Pinewood/Ad 6.mp4',
      durationSec: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 6,
    },
  });
  await mkdir(join(logsDir, 'jobs'), { recursive: true });
  await writeFile(join(logsDir, 'jobs', `${job.id}.log`), 'log');
  const other = jobs.upsertFromScan(makeScan('LAKESHORE', 'Promo')).job;

  const app = createApp({
    clients: {
      jobs,
      clientStyles,
      folders,
      inboxPath,
      exportsDir,
      openFolder: async () => {},
      remove: {
        exportsDir,
        dataDir,
        logsDir,
        jobs,
        series,
        registry: async () => registry,
        team,
        home,
        ...(options.inUse === undefined ? {} : { inUse: options.inUse }),
        ...(options.instagramBusy === undefined ? {} : { instagramBusy: options.instagramBusy }),
        publish: (event) => bus.publish(event),
        logger: { warn: vi.fn(), error: vi.fn() },
      },
    },
  });

  function remove(clientId: string) {
    return app.request(`/api/clients/${clientId}`, { method: 'DELETE' });
  }

  /** Both clients have an Instagram account, a scan, a reel (Pinewood's linked to its job) and a picture. */
  async function addInstagram() {
    await mkdir(join(dataDir, 'instagram', 'photos'), { recursive: true });
    for (const [clientId, client, handle, jobId] of [
      [PINEWOOD, 'Pinewood', 'pinewood.ads', ready.id],
      [LAKESHORE, 'LAKESHORE', 'lakeshore.studio', other.id],
    ] as const) {
      await writeFile(instagramPhotoFor(dataDir, clientId), `${client} jpeg`);
      instagram.upsertAccount({ clientId, client, handle });
      const scan = instagram.startScan({ clientId, handle });
      instagram.finishScan(scan.id, { outcome: 'ok', followers: 900, reelsRead: 1 });
      const shortcode = `reel-${client.toLowerCase()}`;
      instagram.upsertReels(scan.id, [
        {
          shortcode,
          clientId,
          url: `https://www.instagram.com/reel/${shortcode}/`,
          postedAt: 1,
          plays: 10,
          likes: 1,
          comments: 1,
        },
      ]);
      instagram.addReelReads(scan.id, [{ shortcode, plays: 10, likes: 1, comments: 1 }]);
      instagram.linkReel(shortcode, jobId);
    }
  }

  return {
    remove,
    addInstagram,
    instagram,
    jobs,
    clientStyles,
    series,
    deliveries,
    folders,
    team,
    registered,
    events,
    ready,
    other,
    inboxPath,
    exportsDir,
    dataDir,
    logsDir,
    trash: join(home, '.Trash'),
  };
}

describe('DELETE /api/clients/:clientId', () => {
  it('moves the folder and the exports to the Trash and deletes the jobs, logs and history', async () => {
    const t = await setup();

    const response = await t.remove(PINEWOOD);

    expect(response.status).toBe(200);
    expect(deleteClientResponseSchema.parse(await response.json())).toEqual({
      clientId: PINEWOOD,
      client: 'Pinewood',
      trashed: true,
    });
    expect(existsSync(join(t.inboxPath, 'Pinewood'))).toBe(false);
    expect(existsSync(join(t.exportsDir, 'Pinewood'))).toBe(false);
    expect(await readFile(join(t.trash, 'Pinewood', 'Ad 6', 'raw.mp4'), 'utf8')).toBe('raw');
    expect(await readFile(join(t.trash, 'Pinewood', '_Style', 'style.md'), 'utf8')).toBe('# style');
    expect(await readFile(join(t.trash, 'Pinewood exports', 'Ad 6.mp4'), 'utf8')).toBe('export');
    expect(existsSync(join(t.dataDir, 'clients', PINEWOOD))).toBe(false);
    expect(existsSync(join(t.logsDir, 'jobs', `${t.ready.id}.log`))).toBe(false);
    expect(existsSync(join(t.logsDir, 'clients', `${PINEWOOD}.log`))).toBe(false);
    expect(t.jobs.get(t.ready.id)).toBeNull();
    expect(t.folders.list()).toEqual(['LAKESHORE']);
    expect([...t.registered]).toEqual(['LAKESHORE']);
    expect(t.events).toEqual([
      { type: 'client.removed', clientId: PINEWOOD, client: 'Pinewood' },
      { type: 'job.remove', id: t.ready.id },
    ]);
  });

  it('leaves the other clients as they are', async () => {
    const t = await setup();

    expect((await t.remove(PINEWOOD)).status).toBe(200);

    expect(existsSync(join(t.inboxPath, 'LAKESHORE', 'Promo'))).toBe(true);
    expect(t.jobs.get(t.other.id)).toMatchObject({ client: 'LAKESHORE' });
  });

  it('deletes the payments, the series, the style and the editors of the client', async () => {
    const t = await setup();
    const delivery = {
      clientId: PINEWOOD,
      client: 'Pinewood',
      deliveredAt: Date.parse('2026-10-01T10:00:00Z'),
      price: 40,
      currency: 'ILS',
    };
    t.deliveries.record({ ...delivery, jobId: t.ready.id, name: 'Ad 6', relPath: 'Pinewood/Ad 6' });
    // A video whose folder was deleted earlier: only its delivery is left.
    const orphan = idFor('Pinewood/Ad 1');
    t.deliveries.record({ ...delivery, jobId: orphan, name: 'Ad 1', relPath: 'Pinewood/Ad 1' });
    t.deliveries.record({
      ...delivery,
      clientId: LAKESHORE,
      client: 'LAKESHORE',
      jobId: t.other.id,
      name: 'Promo',
      relPath: 'LAKESHORE/Promo',
    });
    const started = t.series.create({
      clientId: PINEWOOD,
      client: 'Pinewood',
      name: 'Ad',
      formatJobId: t.ready.id,
      formatJob: 'Ad 6',
      state: 'ready',
    });
    t.clientStyles.upsert({ clientId: PINEWOOD, client: 'Pinewood', state: 'ready' });
    t.team.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
    t.team.setEditors(PINEWOOD, 'Pinewood', ['yael@example.com']);

    expect((await t.remove(PINEWOOD)).status).toBe(200);

    expect(t.deliveries.list().map((one) => one.jobId)).toEqual([t.other.id]);
    expect(t.series.get(started.id)).toBeNull();
    expect(t.clientStyles.get(PINEWOOD)).toBeNull();
    expect(t.team.editorsOf(PINEWOOD)).toEqual([]);
    expect(t.events).toContainEqual({ type: 'job.remove', id: orphan });
    expect(t.events).toContainEqual({
      type: 'series.removed',
      seriesId: started.id,
      clientId: PINEWOOD,
    });
    expect(t.events.map((event) => event.type)).toContain('money.changed');
    expect(t.events.map((event) => event.type)).toContain('access.changed');
  });

  it('deletes the Instagram picture and every Instagram row of the client, and none of another’s', async () => {
    const t = await setup();
    await t.addInstagram();

    expect((await t.remove(PINEWOOD)).status).toBe(200);

    expect(existsSync(instagramPhotoFor(t.dataDir, PINEWOOD))).toBe(false);
    expect(t.instagram.getAccount(PINEWOOD)).toBeNull();
    expect(t.instagram.latestScan(PINEWOOD)).toBeNull();
    expect(t.instagram.listReels(PINEWOOD)).toEqual([]);
    expect(t.instagram.reelOfJob(t.ready.id)).toBeNull();
    // LAKESHORE keeps all of it.
    expect(await readFile(instagramPhotoFor(t.dataDir, LAKESHORE), 'utf8')).toBe('LAKESHORE jpeg');
    expect(t.instagram.getAccount(LAKESHORE)).toMatchObject({ handle: 'lakeshore.studio' });
    expect(t.instagram.latestOkScan(LAKESHORE)).not.toBeNull();
    expect(t.instagram.reelOfJob(t.other.id)?.shortcode).toBe('reel-lakeshore');
  });

  it('deletes a client that has Instagram rows and no picture', async () => {
    const t = await setup();
    await t.addInstagram();
    await rm(instagramPhotoFor(t.dataDir, PINEWOOD));

    expect((await t.remove(PINEWOOD)).status).toBe(200);

    expect(t.instagram.getAccount(PINEWOOD)).toBeNull();
  });

  it('keeps the Instagram picture and rows while the engine is busy with the client', async () => {
    const t = await setup({ inUse: () => 'A quick fix is being made.' });
    await t.addInstagram();

    expect((await t.remove(PINEWOOD)).status).toBe(409);

    expect(existsSync(instagramPhotoFor(t.dataDir, PINEWOOD))).toBe(true);
    expect(t.instagram.getAccount(PINEWOOD)).not.toBeNull();
    expect(t.instagram.reelOfJob(t.ready.id)).not.toBeNull();
  });

  it('answers 404 for a client without a folder', async () => {
    const t = await setup();

    expect((await t.remove('000000000000')).status).toBe(404);
  });

  it('waits while the engine works on one of the client’s jobs, and changes nothing', async () => {
    const t = await setup({ inUse: () => 'A quick fix is being made.' });

    const response = await t.remove(PINEWOOD);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Wait until the engine is done with “Ad 6” to delete this client.',
    });
    expect(existsSync(join(t.inboxPath, 'Pinewood', 'Ad 6', 'raw.mp4'))).toBe(true);
    expect(t.jobs.get(t.ready.id)).not.toBeNull();
    expect(t.events).toEqual([]);
  });

  it('waits while an Instagram scan of the client is queued or running, and only that client’s', async () => {
    const busy = new Set([PINEWOOD]);
    const t = await setup({ instagramBusy: (clientId) => busy.has(clientId) });

    const response = await t.remove(PINEWOOD);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Wait until the Instagram scan is done to delete this client.',
    });
    expect(existsSync(join(t.inboxPath, 'Pinewood', 'Ad 6', 'raw.mp4'))).toBe(true);
    expect(t.jobs.get(t.ready.id)).not.toBeNull();

    // The scan ends: the same call goes through.
    busy.clear();
    expect((await t.remove(PINEWOOD)).status).toBe(200);
  });

  it('waits while the files of one of the client’s jobs are arriving', async () => {
    const t = await setup();
    t.jobs.upsertFromScan(makeScan('Pinewood', 'Ad 7'));

    const response = await t.remove(PINEWOOD);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Wait until the files of “Ad 7” have arrived to delete this client.',
    });
  });

  it('waits while the client’s style is being read', async () => {
    const t = await setup();
    t.clientStyles.upsert({ clientId: PINEWOOD, client: 'Pinewood', state: 'analysing' });

    expect((await t.remove(PINEWOOD)).status).toBe(409);
    expect(existsSync(join(t.inboxPath, 'Pinewood'))).toBe(true);
  });

  it('numbers the folder when the Trash has one by that name', async () => {
    const t = await setup();
    await mkdir(join(t.trash, 'Pinewood'), { recursive: true });

    expect((await t.remove(PINEWOOD)).status).toBe(200);

    expect(existsSync(join(t.trash, 'Pinewood 2', 'Ad 6', 'raw.mp4'))).toBe(true);
  });

  it('deletes a client whose folder Finder already removed', async () => {
    const t = await setup();
    await rm(join(t.inboxPath, 'Pinewood'), { recursive: true });

    expect((await t.remove(PINEWOOD)).status).toBe(200);

    expect(t.jobs.get(t.ready.id)).toBeNull();
    expect(existsSync(join(t.trash, 'Pinewood exports', 'Ad 6.mp4'))).toBe(true);
  });
});
