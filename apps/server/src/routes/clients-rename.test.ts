import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Job, renameClientResponseSchema, type ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ClientFolders } from '../clients/client-folders.js';
import { instagramPhotoFor } from '../clients/paths.js';
import {
  ClientStyleRepository,
  InstagramRepository,
  JobRepository,
  SeriesRepository,
  type StudioDb,
} from '../db/index.js';
import { fakeClock, idFor, makeScan, memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { clientIdFor, seriesIdFor } from '../inbox/scan.js';
import { TeamService } from '../team/team-service.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// PUT /api/clients/:clientId/name over the real repositories (in memory), the real list of client
// folders and a temp inbox, exports, data folder and logs.

const opened: StudioDb[] = [];
const temps: string[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

const PINEWOOD = clientIdFor('Pinewood');
const LABS = clientIdFor('Pinewood Labs');

async function setup(
  options: {
    inUse?: (job: Job) => string | null;
    instagramBusy?: (clientId: string) => boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'studio-client-rename-'));
  temps.push(root);
  const inboxPath = join(root, 'inbox');
  const exportsDir = join(inboxPath, '_Exports');
  const dataDir = join(root, 'data');
  const logsDir = join(root, 'logs');
  const db = memoryDb();
  opened.push(db);
  const clock = fakeClock();
  const jobs = new JobRepository(db, { clock });
  const clientStyles = new ClientStyleRepository(db, { clock });
  const series = new SeriesRepository(db, { clock });
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
  const expected: string[] = [];

  // Pinewood: a ready job with its export and log, a style folder with a dropped file, a history.
  await mkdir(join(inboxPath, 'Pinewood', 'Ad 6'), { recursive: true });
  await writeFile(join(inboxPath, 'Pinewood', 'Ad 6', 'raw.mp4'), 'raw');
  await mkdir(join(inboxPath, 'Pinewood', '_Style'), { recursive: true });
  await writeFile(join(inboxPath, 'Pinewood', '_Style', 'brand.pdf'), 'pdf');
  await mkdir(join(inboxPath, 'LAKESHORE'), { recursive: true });
  await mkdir(join(exportsDir, 'Pinewood'), { recursive: true });
  await writeFile(join(exportsDir, 'Pinewood', 'Ad 6.mp4'), 'export');
  await mkdir(join(dataDir, 'clients', PINEWOOD, 'history'), { recursive: true });
  await writeFile(join(dataDir, 'clients', PINEWOOD, 'history', '1.md'), '# v1');
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

  const app = createApp({
    clients: {
      jobs,
      clientStyles,
      folders,
      inboxPath,
      exportsDir,
      openFolder: async () => {},
      rename: {
        exportsDir,
        dataDir,
        logsDir,
        jobs,
        series,
        registry: async () => registry,
        team,
        ...(options.inUse === undefined ? {} : { inUse: options.inUse }),
        ...(options.instagramBusy === undefined ? {} : { instagramBusy: options.instagramBusy }),
        uploads: { expectUpload: (client, name) => expected.push(`${client}/${name}`) },
        publish: (event) => bus.publish(event),
        logger: { warn: vi.fn(), error: vi.fn() },
      },
    },
  });

  function rename(clientId: string, name: unknown) {
    return app.request(`/api/clients/${clientId}/name`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  /** Pinewood has an Instagram account, a scan, two reels (one of its job) and a saved picture. */
  async function addInstagram() {
    await mkdir(join(dataDir, 'instagram', 'photos'), { recursive: true });
    await writeFile(instagramPhotoFor(dataDir, PINEWOOD), 'jpeg bytes');
    await writeFile(instagramPhotoFor(dataDir, clientIdFor('LAKESHORE')), 'lakeshore jpeg');
    instagram.upsertAccount({ clientId: PINEWOOD, client: 'Pinewood', handle: 'pinewood.ads' });
    const scan = instagram.startScan({ clientId: PINEWOOD, handle: 'pinewood.ads' });
    instagram.finishScan(scan.id, { outcome: 'ok', followers: 900 });
    const reel = (shortcode: string) => ({
      shortcode,
      clientId: PINEWOOD,
      url: `https://www.instagram.com/reel/${shortcode}/`,
      postedAt: 1,
      plays: 10,
      likes: 1,
      comments: 1,
    });
    instagram.upsertReels(scan.id, [reel('AAA'), reel('BBB')]);
    instagram.linkReel('AAA', ready.id);
    return { scan };
  }

  return {
    rename,
    addInstagram,
    instagram,
    db,
    jobs,
    clientStyles,
    series,
    folders,
    team,
    registered,
    expected,
    events,
    ready,
    inboxPath,
    exportsDir,
    dataDir,
    logsDir,
  };
}

describe('PUT /api/clients/:clientId/name', () => {
  it('moves the folder, the exports, the history, the log and the job to the new name', async () => {
    const t = await setup();

    const response = await t.rename(PINEWOOD, '  Pinewood Labs ');

    expect(response.status).toBe(200);
    const row = renameClientResponseSchema.parse(await response.json());
    expect(row).toMatchObject({ clientId: LABS, client: 'Pinewood Labs', jobs: 1 });
    expect(existsSync(join(t.inboxPath, 'Pinewood'))).toBe(false);
    expect(existsSync(join(t.inboxPath, 'Pinewood Labs', 'Ad 6', 'raw.mp4'))).toBe(true);
    expect(await readFile(join(t.exportsDir, 'Pinewood Labs', 'Ad 6.mp4'), 'utf8')).toBe('export');
    expect(existsSync(join(t.dataDir, 'clients', LABS, 'history', '1.md'))).toBe(true);
    const newJobId = idFor('Pinewood Labs/Ad 6');
    expect(await readFile(join(t.logsDir, 'jobs', `${newJobId}.log`), 'utf8')).toBe('log');
    expect(t.jobs.get(t.ready.id)).toBeNull();
    expect(t.jobs.get(newJobId)).toMatchObject({
      client: 'Pinewood Labs',
      state: 'ready',
      output: { fileName: 'Pinewood Labs/Ad 6.mp4' },
    });
    expect(t.folders.list()).toEqual(['LAKESHORE', 'Pinewood Labs']);
    expect([...t.registered].sort()).toEqual(['LAKESHORE', 'Pinewood Labs']);
    // The style folder's files moved, not dropped: the drops are told before the move.
    expect(t.expected).toEqual(['Pinewood Labs/brand.pdf']);
    expect(t.events.map((event) => event.type)).toEqual([
      'client.removed',
      'client.added',
      'job.upsert',
      'job.remove',
    ]);
  });

  it('moves the client’s editors and its series', async () => {
    const t = await setup();
    t.team.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
    t.team.setEditors(PINEWOOD, 'Pinewood', ['yael@example.com']);
    const started = t.series.create({
      clientId: PINEWOOD,
      client: 'Pinewood',
      name: 'Ad',
      formatJobId: t.ready.id,
      formatJob: 'Ad 6',
      state: 'ready',
    });
    await mkdir(join(t.dataDir, 'clients', PINEWOOD, 'series', started.id, 'history'), {
      recursive: true,
    });

    const response = await t.rename(PINEWOOD, 'Pinewood Labs');

    expect(response.status).toBe(200);
    expect(t.team.editorsOf(PINEWOOD)).toEqual([]);
    expect(t.team.editorsOf(LABS)).toEqual(['yael@example.com']);
    const newSeriesId = seriesIdFor(LABS, 'Ad');
    expect(t.series.get(newSeriesId)).toMatchObject({ client: 'Pinewood Labs' });
    expect(existsSync(join(t.dataDir, 'clients', LABS, 'series', newSeriesId, 'history'))).toBe(
      true,
    );
    expect(t.events.map((event) => event.type)).toContain('access.changed');
    expect(t.events).toContainEqual({
      type: 'series.removed',
      seriesId: started.id,
      clientId: PINEWOOD,
    });
  });

  it('moves the Instagram picture and every Instagram row to the new client', async () => {
    const t = await setup();
    const { scan } = await t.addInstagram();

    expect((await t.rename(PINEWOOD, 'Pinewood Labs')).status).toBe(200);

    const newJobId = idFor('Pinewood Labs/Ad 6');
    expect(existsSync(instagramPhotoFor(t.dataDir, PINEWOOD))).toBe(false);
    expect(await readFile(instagramPhotoFor(t.dataDir, LABS), 'utf8')).toBe('jpeg bytes');
    // Another client’s picture stays where it is.
    expect(await readFile(instagramPhotoFor(t.dataDir, clientIdFor('LAKESHORE')), 'utf8')).toBe(
      'lakeshore jpeg',
    );
    expect(t.instagram.getAccount(PINEWOOD)).toBeNull();
    expect(t.instagram.getAccount(LABS)).toMatchObject({
      client: 'Pinewood Labs',
      handle: 'pinewood.ads',
    });
    expect(t.instagram.latestOkScan(LABS)).toMatchObject({ id: scan.id, followers: 900 });
    expect(t.instagram.listReels(PINEWOOD)).toEqual([]);
    expect(t.instagram.listReels(LABS).map((reel) => reel.shortcode)).toEqual(['AAA', 'BBB']);
    expect(t.instagram.reelOfJob(newJobId)?.shortcode).toBe('AAA');
    expect(t.instagram.reelOfJob(t.ready.id)).toBeNull();
  });

  it('renames a client that has Instagram rows and no picture yet', async () => {
    const t = await setup();
    await t.addInstagram();
    await rm(instagramPhotoFor(t.dataDir, PINEWOOD));

    expect((await t.rename(PINEWOOD, 'Pinewood Labs')).status).toBe(200);

    expect(existsSync(instagramPhotoFor(t.dataDir, LABS))).toBe(false);
    expect(t.instagram.getAccount(LABS)).not.toBeNull();
  });

  it('puts the picture back when the Instagram rows cannot move', async () => {
    const t = await setup();
    await t.addInstagram();
    // Rows left by an earlier client of the new name: the database refuses it.
    t.instagram.upsertAccount({ clientId: LABS, client: 'Pinewood Labs', handle: 'old.labs' });

    const response = await t.rename(PINEWOOD, 'Pinewood Labs');

    expect(response.status).toBe(409);
    expect(await readFile(instagramPhotoFor(t.dataDir, PINEWOOD), 'utf8')).toBe('jpeg bytes');
    expect(existsSync(instagramPhotoFor(t.dataDir, LABS))).toBe(false);
    expect(t.instagram.getAccount(PINEWOOD)).toMatchObject({ handle: 'pinewood.ads' });
    expect(t.instagram.reelOfJob(t.ready.id)?.shortcode).toBe('AAA');
    expect(existsSync(join(t.inboxPath, 'Pinewood', 'Ad 6', 'raw.mp4'))).toBe(true);
  });

  it('refuses a name that is taken, and changes nothing', async () => {
    const t = await setup();

    const response = await t.rename(PINEWOOD, 'LAKESHORE');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'There is already a client or file called “LAKESHORE” in the inbox.',
    });
    expect(existsSync(join(t.inboxPath, 'Pinewood', 'Ad 6'))).toBe(true);
    expect(t.jobs.get(t.ready.id)).not.toBeNull();
  });

  it('refuses a name a client cannot have', async () => {
    const t = await setup();

    expect((await t.rename(PINEWOOD, '_Exports')).status).toBe(400);
    expect((await t.rename(PINEWOOD, 'A/B')).status).toBe(400);
    expect((await t.rename(PINEWOOD, '')).status).toBe(400);
  });

  it('answers 404 for a client without a folder', async () => {
    const t = await setup();

    expect((await t.rename('000000000000', 'Pinewood Labs')).status).toBe(404);
  });

  it('waits while the engine works on one of the client’s jobs', async () => {
    const t = await setup({ inUse: () => 'A quick fix is being made.' });

    const response = await t.rename(PINEWOOD, 'Pinewood Labs');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Wait until the engine is done with “Ad 6” to rename this client.',
    });
    expect(existsSync(join(t.inboxPath, 'Pinewood'))).toBe(true);
  });

  it('waits while an Instagram scan of the client is queued or running, and only that client’s', async () => {
    const busy = new Set([PINEWOOD]);
    const t = await setup({ instagramBusy: (clientId) => busy.has(clientId) });

    const response = await t.rename(PINEWOOD, 'Pinewood Labs');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Wait until the Instagram scan is done to rename this client.',
    });
    expect(existsSync(join(t.inboxPath, 'Pinewood', 'Ad 6', 'raw.mp4'))).toBe(true);
    expect(t.jobs.get(t.ready.id)).not.toBeNull();

    // The scan ends: the same call goes through.
    busy.clear();
    expect((await t.rename(PINEWOOD, 'Pinewood Labs')).status).toBe(200);
  });

  it('waits while the files of one of the client’s jobs are arriving', async () => {
    const t = await setup();
    t.jobs.upsertFromScan(makeScan('Pinewood', 'Ad 7'));

    const response = await t.rename(PINEWOOD, 'Pinewood Labs');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Wait until the files of “Ad 7” have arrived to rename this client.',
    });
  });

  it('waits while the client’s style is being read', async () => {
    const t = await setup();
    t.clientStyles.upsert({ clientId: PINEWOOD, client: 'Pinewood', state: 'analysing' });

    expect((await t.rename(PINEWOOD, 'Pinewood Labs')).status).toBe(409);
  });

  it('puts the folders back when the rows cannot move', async () => {
    const t = await setup();
    // A style left by an earlier client of the new name: the database refuses the name.
    t.clientStyles.upsert({ clientId: LABS, client: 'Pinewood Labs', state: 'ready' });

    const response = await t.rename(PINEWOOD, 'Pinewood Labs');

    expect(response.status).toBe(409);
    expect(existsSync(join(t.inboxPath, 'Pinewood', 'Ad 6', 'raw.mp4'))).toBe(true);
    expect(existsSync(join(t.inboxPath, 'Pinewood Labs'))).toBe(false);
    expect(existsSync(join(t.exportsDir, 'Pinewood', 'Ad 6.mp4'))).toBe(true);
    expect(existsSync(join(t.dataDir, 'clients', PINEWOOD, 'history', '1.md'))).toBe(true);
    expect([...t.registered].sort()).toEqual(['LAKESHORE', 'Pinewood']);
    expect(t.jobs.get(t.ready.id)).not.toBeNull();
    expect(t.events).toEqual([]);
  });

  it('gives a price in money.json to the new name', async () => {
    const t = await setup();
    await writeFile(
      join(t.dataDir, 'money.json'),
      JSON.stringify({ pricePerJob: 40, clientPrices: { Pinewood: 55, LAKESHORE: 30 } }),
    );

    expect((await t.rename(PINEWOOD, 'Pinewood Labs')).status).toBe(200);

    expect(JSON.parse(await readFile(join(t.dataDir, 'money.json'), 'utf8'))).toEqual({
      pricePerJob: 40,
      clientPrices: { 'Pinewood Labs': 55, LAKESHORE: 30 },
    });
  });

  it('answers the row as it is for the same name', async () => {
    const t = await setup();

    const response = await t.rename(PINEWOOD, 'Pinewood');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clientId: PINEWOOD, client: 'Pinewood' });
    expect(t.events).toEqual([]);
  });
});
