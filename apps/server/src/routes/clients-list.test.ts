import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiErrorSchema,
  clientListResponseSchema,
  clientStyleResponseSchema,
  clientStyleSchema,
  createClientResponseSchema,
  type ServerEvent,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ClientFolders } from '../clients/client-folders.js';
import type { StyleRunner } from '../clients/style-run.js';
import { StyleWorker } from '../clients/style-worker.js';
import {
  ClientStyleRepository,
  InstagramRepository,
  JobRepository,
  type StudioDb,
} from '../db/index.js';
import { fakeClock, makeScan, memoryDb, T0 } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { readClientInstagramSummary } from '../instagram/client-instagram.js';
import { TeamService } from '../team/team-service.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The client list and New client over the real repositories (in memory), the real list of client
// folders and a temp inbox, `app.request` for the HTTP. A client is a folder directly in the
// inbox: the second half checks that one with no job is a client for the style, upload, retry,
// reveal and undo routes like any other. The style worker is real and never started, so a queued
// pass stays queued and can be looked at.

let inbox: string;
let dataDir: string;
let db: StudioDb;
let clock: ReturnType<typeof fakeClock>;
let jobs: JobRepository;
let clientStyles: ClientStyleRepository;
let folders: ClientFolders;
let worker: StyleWorker;
let events: ServerEvent[];
let opened: string[];
let app: Hono;

const neverRuns: StyleRunner = {
  run: async () => {
    throw new Error('the worker is not started in these tests');
  },
};

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-client-list-routes-'));
  dataDir = mkdtempSync(join(tmpdir(), 'studio-client-list-data-'));
  db = memoryDb();
  clock = fakeClock();
  jobs = new JobRepository(db, { clock });
  clientStyles = new ClientStyleRepository(db, { clock });
  const bus = createEventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  folders = new ClientFolders(bus);
  worker = new StyleWorker({ clientStyles, inboxPath: inbox, dataDir, runner: neverRuns });
  opened = [];
  app = createApp({
    clients: {
      jobs,
      clientStyles,
      folders,
      inboxPath: inbox,
      exportsDir: join(inbox, '_Exports'),
      openFolder: async (path) => {
        opened.push(path);
      },
      styles: { worker, uploads: { expectUpload: () => {} }, maxUploadBytes: 1_000 },
    },
  });
});

afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(inbox, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const getList = () => app.request('/api/clients');

const postClient = (body: unknown, application: Hono = app) =>
  application.request('/api/clients', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** A client folder on disk that the engine has listed: no job, no style. */
function emptyClient(name: string): string {
  mkdirSync(join(inbox, name, '_Style'), { recursive: true });
  folders.add(name);
  events.length = 0;
  return clientIdFor(name);
}

const styleDir = (name: string) => join(inbox, name, '_Style');

async function errorOf(res: Response): Promise<string> {
  return apiErrorSchema.parse(await res.json()).error;
}

describe('GET /api/clients', () => {
  it('answers an empty list when the inbox has no client folder', async () => {
    const res = await getList();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('lists a client folder that has no job: no jobs, no last job, no style', async () => {
    const id = emptyClient('Empty Client');

    const res = await getList();

    expect(res.status).toBe(200);
    expect(clientListResponseSchema.parse(await res.json())).toEqual([
      {
        clientId: id,
        client: 'Empty Client',
        jobs: 0,
        lastJobAt: null,
        style: { state: 'none', updatedAt: null },
      },
    ]);
  });

  it('counts the jobs of each client, tells when the newest arrived and sorts by name', async () => {
    emptyClient('Kova Coffee');
    emptyClient('Arc Fitness');
    emptyClient('מאפיית הצפון');
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));
    clock.tick(30_000);
    const newest = jobs.upsertFromScan(makeScan('Kova Coffee', 'Opening')).job;
    clientStyles.upsert({
      clientId: clientIdFor('Kova Coffee'),
      client: 'Kova Coffee',
      state: 'ready',
      version: 1,
      updatedAt: '2026-10-18T09:30:00.000Z',
    });

    const rows = clientListResponseSchema.parse(await (await getList()).json());

    expect(rows.map((row) => row.client)).toEqual(['Arc Fitness', 'Kova Coffee', 'מאפיית הצפון']);
    expect(rows[1]).toEqual({
      clientId: clientIdFor('Kova Coffee'),
      client: 'Kova Coffee',
      jobs: 2,
      lastJobAt: newest.addedAt,
      style: { state: 'ready', updatedAt: '2026-10-18T09:30:00.000Z' },
    });
    expect(Date.parse(newest.addedAt)).toBe(Date.parse(T0) + 30_000);
    expect(rows[0]).toMatchObject({ jobs: 0, lastJobAt: null });
  });

  it('still counts the archived jobs of a client: archiving only hides a job from the lists (CVP-196)', async () => {
    emptyClient('Kova Coffee');
    const ids = ['Menu', 'Opening', 'Teaser'].map(
      (name) => jobs.upsertFromScan(makeScan('Kova Coffee', name)).job.id,
    );
    const output = {
      fileName: 'Kova Coffee/x.mp4',
      durationSec: 30,
      width: 1080,
      height: 1920,
      sizeBytes: 1,
    };
    // Two jobs are ready and archived, the third is still arriving.
    for (const id of ids.slice(0, 2)) {
      for (const event of [
        { type: 'SETTLED' },
        { type: 'START' },
        { type: 'SUCCEED', output },
      ] as const) {
        clock.tick();
        jobs.applyTransition(id, event);
      }
    }
    const before = clientListResponseSchema.parse(await (await getList()).json());

    jobs.archive(ids.slice(0, 2));
    const after = clientListResponseSchema.parse(await (await getList()).json());

    expect(jobs.getAll().filter((job) => job.archivedAt !== null)).toHaveLength(2);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ client: 'Kova Coffee', jobs: 3 });
  });

  it('forgets a client folder once the list drops it', async () => {
    emptyClient('Arc Fitness');
    emptyClient('Kova Coffee');
    folders.remove('Arc Fitness');

    const rows = clientListResponseSchema.parse(await (await getList()).json());

    expect(rows.map((row) => row.client)).toEqual(['Kova Coffee']);
  });

  it('waits for the boot to list the client folders, rather than answer with none', async () => {
    // Right after a restart the server answers before the inbox boot has listed the folders; an
    // empty answer then stayed on the Clients page until a reload (the owner, 30 Oct).
    const booting = new ClientFolders(createEventBus());
    booting.expectSeed();
    const app = createApp({
      clients: {
        jobs,
        clientStyles,
        folders: booting,
        inboxPath: inbox,
        openFolder: async () => {},
      },
    });
    let answered = false;
    const res = Promise.resolve(app.request('/api/clients')).then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);

    booting.seed(['Acme']);

    const list = clientListResponseSchema.parse(await (await res).json());
    expect(list.map((row) => row.client)).toEqual(['Acme']);
  });

  it('is not there without the list of client folders', async () => {
    const bare = createApp({
      clients: { jobs, clientStyles, inboxPath: inbox, openFolder: async () => {} },
    });

    expect((await bare.request('/api/clients')).status).toBe(404);
    expect((await postClient({ name: 'Acme' }, bare)).status).toBe(404);
  });
});

describe('GET /api/clients and Instagram (IG6)', () => {
  /** An app whose list says each client's Instagram, as the engine wires it while the switch is on. */
  function instagramApp() {
    const repo = new InstagramRepository(db, { clock });
    const now = Date.parse('2026-10-27T10:00:00.000Z');
    const application = createApp({
      clients: {
        jobs,
        clientStyles,
        folders,
        inboxPath: inbox,
        exportsDir: join(inbox, '_Exports'),
        openFolder: async () => {},
        instagram: {
          summary: (clientId) =>
            readClientInstagramSummary(repo, clientId, { now, timeZone: 'UTC' }),
        },
      },
    });
    return { repo, application };
  }

  function twoScans(repo: InstagramRepository, clientId: string) {
    repo.upsertAccount({
      clientId,
      client: 'Kova Coffee',
      handle: 'kova.coffee',
      photoSavedAt: Date.parse('2026-10-19T06:01:00.000Z'),
    });
    for (const [at, followers] of [
      ['2026-10-19T06:00:00.000Z', 4_000],
      ['2026-10-26T06:00:00.000Z', 4_064],
    ] as const) {
      const scan = repo.startScan({ clientId, handle: 'kova.coffee', startedAt: Date.parse(at) });
      repo.finishScan(scan.id, { outcome: 'ok', followers, finishedAt: Date.parse(at) + 1_000 });
      repo.upsertReels(scan.id, [
        {
          shortcode: 'OURS1',
          clientId,
          url: 'https://www.instagram.com/reel/OURS1/',
          postedAt: Date.parse('2026-10-21T12:00:00.000Z'),
          plays: 6_000,
          likes: 100,
          comments: 1,
        },
        {
          shortcode: 'THEIRS1',
          clientId,
          url: 'https://www.instagram.com/reel/THEIRS1/',
          postedAt: Date.parse('2026-10-22T12:00:00.000Z'),
          plays: 2_000,
          likes: 100,
          comments: 1,
        },
      ]);
    }
    repo.linkReel('OURS1', 'a-job');
  }

  it('has no instagram on a row while the switch is off', async () => {
    emptyClient('Kova Coffee');

    const [row] = clientListResponseSchema.parse(await (await getList()).json());

    expect(row).toBeDefined();
    expect(row && 'instagram' in row).toBe(false);
  });

  it('gives a client with no account an instagram of null, and one with an account its numbers', async () => {
    const { repo, application } = instagramApp();
    const kova = emptyClient('Kova Coffee');
    emptyClient('Arc Fitness');
    twoScans(repo, kova);

    const rows = clientListResponseSchema.parse(
      await (await application.request('/api/clients')).json(),
    );

    expect(rows.map((row) => [row.client, row.instagram])).toEqual([
      ['Arc Fitness', null],
      [
        'Kova Coffee',
        {
          handle: 'kova.coffee',
          followers: 4_064,
          weekChange: 64,
          oursVsTheirs: 3,
          photoAt: '2026-10-19T06:01:00.000Z',
        },
      ],
    ]);
  });

  it('has the handle and no numbers for an account that has not been scanned yet', async () => {
    const { repo, application } = instagramApp();
    const id = emptyClient('Kova Coffee');
    repo.upsertAccount({ clientId: id, client: 'Kova Coffee', handle: 'kova.coffee' });

    const [row] = clientListResponseSchema.parse(
      await (await application.request('/api/clients')).json(),
    );

    expect(row?.instagram).toEqual({
      handle: 'kova.coffee',
      followers: null,
      weekChange: null,
      oursVsTheirs: null,
      photoAt: null,
    });
  });

  it('answers the new client with an instagram of null too', async () => {
    const { application } = instagramApp();

    const res = await postClient({ name: 'Fresh Client' }, application);

    expect(res.status).toBe(201);
    expect(createClientResponseSchema.parse(await res.json()).instagram).toBeNull();
  });
});

describe('POST /api/clients and the team', () => {
  const MAC = 'studio-mac.tail1234.ts.net';

  function teamApp() {
    const team = new TeamService(join(dataDir, 'team.json'));
    team.upsertUser({ email: 'yael@example.com', name: 'Yael', role: 'editor' });
    const app = createApp({
      remoteAccess: () => ({ hosts: [MAC], logins: ['owner@example.com'] }),
      team,
      clients: {
        jobs,
        clientStyles,
        folders,
        inboxPath: inbox,
        exportsDir: join(inbox, '_Exports'),
        openFolder: async () => {},
        onClientCreated: (client, creator) =>
          team.autoAssign(client.clientId, client.client, creator),
      },
    });
    const create = (name: string, login: string | null) =>
      app.request(
        `http://${MAC}/api/clients`,
        {
          method: 'POST',
          headers: {
            host: MAC,
            'content-type': 'application/json',
            'x-forwarded-for': '100.64.0.1',
            ...(login === null ? {} : { 'tailscale-user-login': login }),
          },
          body: JSON.stringify({ name }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    return { team, create };
  }

  it('gives a client an editor creates to that editor', async () => {
    const { team, create } = teamApp();
    expect((await create('Yael Client', 'yael@example.com')).status).toBe(201);
    expect(team.editorsOf(clientIdFor('Yael Client'))).toEqual(['yael@example.com']);
    expect(team.assignments()[clientIdFor('Yael Client')]?.client).toBe('Yael Client');
  });

  it('leaves a client the admin creates unassigned: admin only', async () => {
    const { team, create } = teamApp();
    expect((await create('Admin Client', 'owner@example.com')).status).toBe(201);
    expect(team.editorsOf(clientIdFor('Admin Client'))).toEqual([]);
  });
});

describe('POST /api/clients', () => {
  it('makes the folder and its _Style, and answers the new row', async () => {
    const res = await postClient({ name: 'Kova Coffee' });

    expect(res.status).toBe(201);
    expect(createClientResponseSchema.parse(await res.json())).toEqual({
      clientId: clientIdFor('Kova Coffee'),
      client: 'Kova Coffee',
      jobs: 0,
      lastJobAt: null,
      style: { state: 'none', updatedAt: null },
    });
    expect(readdirSync(inbox)).toEqual(['Kova Coffee']);
    expect(readdirSync(styleDir('Kova Coffee'))).toEqual([]);
  });

  it('puts the new client in the list and announces it once', async () => {
    await postClient({ name: 'Kova Coffee' });

    const rows = clientListResponseSchema.parse(await (await getList()).json());
    expect(rows.map((row) => row.client)).toEqual(['Kova Coffee']);
    expect(events).toEqual([
      { type: 'client.added', clientId: clientIdFor('Kova Coffee'), client: 'Kova Coffee' },
    ]);
  });

  it('trims the name and writes it in NFC', async () => {
    const res = await postClient({ name: `  ${'Café Müller'.normalize('NFD')}  ` });

    expect(res.status).toBe(201);
    const row = createClientResponseSchema.parse(await res.json());
    expect(row.client).toBe('Café Müller'.normalize('NFC'));
    expect(row.clientId).toBe(clientIdFor('Café Müller'));
    expect(readdirSync(inbox).map((entry) => entry.normalize('NFC'))).toEqual([row.client]);
  });

  it('never makes a job, and the job list is as it was', async () => {
    await postClient({ name: 'Kova Coffee' });
    await postClient({ name: 'מאפיית הצפון' });

    expect(jobs.getAll()).toEqual([]);
    expect(readdirSync(join(inbox, 'Kova Coffee'))).toEqual(['_Style']);
    expect(readdirSync(join(inbox, 'מאפיית הצפון'))).toEqual(['_Style']);
  });

  it.each([
    ['an empty name', { name: '' }, 'Give the client a name.'],
    ['a name of spaces', { name: '   ' }, 'Give the client a name.'],
    ['a name over 80 characters', { name: 'x'.repeat(81) }, 'at most 80 characters'],
    ['a slash', { name: 'Acme/Spring' }, 'contain / or :'],
    ['a colon', { name: 'Acme: Spring' }, 'contain / or :'],
    ['a leading dot', { name: '.hidden' }, 'start with . or _'],
    ['a leading underscore', { name: '_Style' }, 'start with . or _'],
    ['a zero-width space', { name: 'Amit Studio\u200B' }, 'hidden characters'],
    ['a no-break space inside', { name: 'Amit\u00A0Studio' }, 'hidden characters'],
    ['a soft hyphen', { name: 'Amit\u00ADStudio' }, 'hidden characters'],
    ['a double space', { name: 'Amit  Studio' }, 'two spaces in a row'],
    ['no name', {}, 'Give the client a name.'],
    ['a name that is not text', { name: 7 }, 'Give the client a name.'],
    ['the name of the exports folder', { name: 'Exports' }, null],
  ])('answers 400 with a plain message for %s', async (label, body, words) => {
    const withExports = createApp({
      clients: {
        jobs,
        clientStyles,
        folders,
        inboxPath: inbox,
        exportsDir: join(inbox, 'Exports'),
        openFolder: async () => {},
      },
    });

    const res = await postClient(
      body,
      label === 'the name of the exports folder' ? withExports : app,
    );

    expect(res.status).toBe(400);
    const message = await errorOf(res);
    if (words !== null) expect(message).toContain(words);
    expect(readdirSync(inbox)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await postClient('name=Acme');

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('JSON');
    expect(readdirSync(inbox)).toEqual([]);
  });

  it('answers 409 when a client folder has that name, and changes nothing', async () => {
    emptyClient('Kova Coffee');

    const res = await postClient({ name: 'Kova Coffee' });

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('Kova Coffee');
    expect(readdirSync(inbox)).toEqual(['Kova Coffee']);
    expect(events).toEqual([]);
  });

  it('answers 409 when the folder is there under the other Unicode spelling', async () => {
    const nfc = 'Café Müller'.normalize('NFC');
    mkdirSync(join(inbox, nfc.normalize('NFD')));
    const asDecomposed = await postClient({ name: nfc });
    expect(asDecomposed.status).toBe(409);

    rmSync(join(inbox, nfc.normalize('NFD')), { recursive: true });
    mkdirSync(join(inbox, nfc));
    const asComposed = await postClient({ name: nfc.normalize('NFD') });
    expect(asComposed.status).toBe(409);

    expect(readdirSync(inbox)).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('answers 409 for a client that has jobs, folder and all', async () => {
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));
    mkdirSync(join(inbox, 'Kova Coffee', 'Menu'), { recursive: true });

    expect((await postClient({ name: 'Kova Coffee' })).status).toBe(409);
    expect(readdirSync(join(inbox, 'Kova Coffee'))).toEqual(['Menu']);
  });

  it('answers 500 and makes nothing when the inbox folder is gone', async () => {
    rmSync(inbox, { recursive: true, force: true });

    const res = await postClient({ name: 'Kova Coffee' });

    expect(res.status).toBe(500);
    expect(await errorOf(res)).toContain('inbox folder is missing');
    expect(existsSync(inbox)).toBe(false);
  });
});

describe('a client folder with no job is a client', () => {
  it('has a style page: state none, no markdown', async () => {
    const id = emptyClient('Empty Client');

    const res = await app.request(`/api/clients/${id}/style`);

    expect(res.status).toBe(200);
    expect(clientStyleResponseSchema.parse(await res.json())).toEqual({
      clientId: id,
      client: 'Empty Client',
      state: 'none',
      version: 0,
      updatedAt: null,
      error: null,
      sourceJobId: null,
      pass: null,
      markdown: null,
    });
  });

  it('shows the style.md written in its _Style folder', async () => {
    const id = emptyClient('Empty Client');
    writeFileSync(join(styleDir('Empty Client'), 'style.md'), '# Style: Empty Client\n');

    const body = clientStyleResponseSchema.parse(
      await (await app.request(`/api/clients/${id}/style`)).json(),
    );

    expect(body.markdown).toBe('# Style: Empty Client\n');
  });

  it('is unknown once its folder is gone from the list, with no job and no style', async () => {
    const id = emptyClient('Empty Client');
    folders.remove('Empty Client');

    expect((await app.request(`/api/clients/${id}/style`)).status).toBe(404);
    expect((await app.request(`/api/clients/${id}/reveal`, { method: 'POST' })).status).toBe(404);
  });

  it('opens its folder in Finder', async () => {
    const id = emptyClient('Empty Client');

    const res = await app.request(`/api/clients/${id}/reveal`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(opened).toEqual([join(inbox, 'Empty Client')]);
  });

  it('takes files for its style: they land in _Style and a pass is queued', async () => {
    const id = emptyClient('Empty Client');
    const body = new FormData();
    body.append('files[]', new File(['png'], 'logo.png'));
    body.append('files[]', new File(['Warm, calm.'], 'notes.txt'));

    const res = await app.request(`/api/clients/${id}/style/files`, { method: 'POST', body });

    expect(res.status).toBe(200);
    const style = clientStyleSchema.parse(await res.json());
    expect(style).toMatchObject({ clientId: id, client: 'Empty Client', state: 'analysing' });
    expect(style.pass).toMatchObject({ kind: 'read', mode: 'create', fileCount: 2 });
    expect(readdirSync(styleDir('Empty Client')).sort()).toEqual(['logo.png', 'notes.txt']);
    expect(clientStyles.get(id)?.state).toBe('analysing');
  });

  it('refuses an upload with no files, or too large, as it does for any client', async () => {
    const id = emptyClient('Empty Client');

    const empty = await app.request(`/api/clients/${id}/style/files`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(empty.status).toBe(400);

    const big = new FormData();
    big.append('files[]', new File(['x'.repeat(2_000)], 'big.bin'));
    const tooBig = await app.request(`/api/clients/${id}/style/files`, {
      method: 'POST',
      body: big,
    });
    expect(tooBig.status).toBe(413);
  });

  it('answers 404 to an upload when its folder is gone from the disk', async () => {
    const id = emptyClient('Empty Client');
    rmSync(join(inbox, 'Empty Client'), { recursive: true });
    const body = new FormData();
    body.append('files[]', new File(['png'], 'logo.png'));

    const res = await app.request(`/api/clients/${id}/style/files`, { method: 'POST', body });

    expect(res.status).toBe(404);
    expect(existsSync(join(inbox, 'Empty Client'))).toBe(false);
  });

  it('runs Retry: refused while the style has not failed, queued again once it has', async () => {
    const id = emptyClient('Empty Client');
    const refused = await app.request(`/api/clients/${id}/style/retry`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toContain('nothing to retry');

    clientStyles.upsert({
      clientId: id,
      client: 'Empty Client',
      state: 'failed',
      error: 'Style stopped: the file is missing',
      lastPass: { kind: 'read', mode: 'create', files: [{ name: 'logo.png', size: 3 }] },
    });
    const retried = await app.request(`/api/clients/${id}/style/retry`, { method: 'POST' });

    expect(retried.status).toBe(200);
    expect(clientStyleSchema.parse(await retried.json())).toMatchObject({
      clientId: id,
      state: 'analysing',
    });
  });

  it('runs Undo: refused with nothing kept, and puts the kept style back when there is one', async () => {
    const id = emptyClient('Empty Client');
    const refused = await app.request(`/api/clients/${id}/style/undo`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toContain('no earlier style');

    mkdirSync(join(dataDir, 'clients', id, 'history'), { recursive: true });
    writeFileSync(join(dataDir, 'clients', id, 'history', '1.md'), '# first look\n');
    writeFileSync(join(styleDir('Empty Client'), 'style.md'), '# second look\n');
    clientStyles.upsert({ clientId: id, client: 'Empty Client', state: 'ready', version: 2 });

    const undone = await app.request(`/api/clients/${id}/style/undo`, { method: 'POST' });

    expect(undone.status).toBe(200);
    expect(clientStyleSchema.parse(await undone.json())).toMatchObject({
      clientId: id,
      state: 'ready',
      version: 3,
    });
    const style = clientStyleResponseSchema.parse(
      await (await app.request(`/api/clients/${id}/style`)).json(),
    );
    expect(style.markdown).toBe('# first look\n');
  });
});
