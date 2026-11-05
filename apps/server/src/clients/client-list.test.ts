import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository, JobRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb, T0 } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { ClientFolders } from './client-folders.js';
import {
  CreateClientError,
  type CreateClientOptions,
  clientRow,
  createClientFolder,
  listClients,
} from './client-list.js';

let inbox: string;
let db: StudioDb;
let clock: ReturnType<typeof fakeClock>;
let jobs: JobRepository;
let clientStyles: ClientStyleRepository;
let folders: ClientFolders;
let events: ServerEvent[];

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-client-list-'));
  db = memoryDb();
  clock = fakeClock();
  jobs = new JobRepository(db, { clock });
  clientStyles = new ClientStyleRepository(db, { clock });
  const bus = createEventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  folders = new ClientFolders(bus);
});

afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(inbox, { recursive: true, force: true });
});

const sources = () => ({ folders, jobs, clientStyles });

describe('listClients', () => {
  it('has a row for every client folder, with or without jobs, sorted by name', () => {
    for (const name of ['Kova Coffee', 'Arc Fitness', 'Empty Client']) folders.add(name);
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));

    const rows = listClients(sources());

    expect(rows.map((row) => row.client)).toEqual(['Arc Fitness', 'Empty Client', 'Kova Coffee']);
    expect(rows.map((row) => row.clientId)).toEqual(
      ['Arc Fitness', 'Empty Client', 'Kova Coffee'].map(clientIdFor),
    );
  });

  it('counts the jobs of a client and gives the newest one’s addedAt as lastJobAt', () => {
    folders.add('Kova Coffee');
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));
    clock.tick(60_000);
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Opening'));
    clock.tick(60_000);
    const newest = jobs.upsertFromScan(makeScan('Kova Coffee', 'Winter')).job;

    expect(listClients(sources())).toEqual([
      {
        clientId: clientIdFor('Kova Coffee'),
        client: 'Kova Coffee',
        jobs: 3,
        lastJobAt: newest.addedAt,
        style: { state: 'none', updatedAt: null },
      },
    ]);
    expect(newest.addedAt).toBe(new Date(Date.parse(T0) + 120_000).toISOString());
  });

  it('gives a client without jobs zero jobs and no lastJobAt', () => {
    folders.add('Empty Client');

    expect(listClients(sources())).toEqual([
      {
        clientId: clientIdFor('Empty Client'),
        client: 'Empty Client',
        jobs: 0,
        lastJobAt: null,
        style: { state: 'none', updatedAt: null },
      },
    ]);
  });

  it('counts only the jobs of each client, and a removed job no longer counts', () => {
    folders.add('Arc Fitness');
    folders.add('Kova Coffee');
    const gone = jobs.upsertFromScan(makeScan('Arc Fitness', 'Spring')).job;
    jobs.upsertFromScan(makeScan('Arc Fitness', 'Summer'));
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));
    jobs.remove(gone.id);

    const byName = Object.fromEntries(listClients(sources()).map((row) => [row.client, row.jobs]));
    expect(byName).toEqual({ 'Arc Fitness': 1, 'Kova Coffee': 1 });
  });

  it('adds up jobs scanned under the NFC and the NFD spelling of the client folder', () => {
    const nfc = 'Café Müller';
    const nfd = nfc.normalize('NFD');
    folders.add(nfd);
    jobs.upsertFromScan(makeScan(nfc, 'Spring'));
    clock.tick(1_000);
    const later = jobs.upsertFromScan(makeScan(nfd, 'Summer')).job;

    const [row, ...rest] = listClients(sources());

    expect(rest).toEqual([]);
    expect(row).toMatchObject({ client: nfd, jobs: 2, lastJobAt: later.addedAt });
  });

  it('shows where the style stands, and lists no client that has jobs but no folder', () => {
    folders.add('Kova Coffee');
    jobs.upsertFromScan(makeScan('No Folder', 'Menu'));
    clientStyles.upsert({
      clientId: clientIdFor('Kova Coffee'),
      client: 'Kova Coffee',
      state: 'ready',
      version: 2,
      updatedAt: '2026-10-18T09:30:00.000Z',
    });

    expect(listClients(sources())).toEqual([
      {
        clientId: clientIdFor('Kova Coffee'),
        client: 'Kova Coffee',
        jobs: 0,
        lastJobAt: null,
        style: { state: 'ready', updatedAt: '2026-10-18T09:30:00.000Z' },
      },
    ]);
  });

  it('has no rows without client folders', () => {
    expect(listClients(sources())).toEqual([]);
  });

  it('gives the row of one client without needing the list', () => {
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));
    expect(clientRow({ jobs, clientStyles }, 'Kova Coffee')).toMatchObject({
      client: 'Kova Coffee',
      jobs: 1,
    });
    expect(clientRow({ jobs, clientStyles }, 'Brand New')).toEqual({
      clientId: clientIdFor('Brand New'),
      client: 'Brand New',
      jobs: 0,
      lastJobAt: null,
      style: { state: 'none', updatedAt: null },
    });
  });
});

describe('createClientFolder', () => {
  const create = (name: string, extra: Partial<CreateClientOptions> = {}) =>
    createClientFolder({ inboxPath: inbox, folders, ...extra }, name);

  /** What the call refuses with, or fails the test. */
  async function refusal(name: string, extra: Partial<CreateClientOptions> = {}) {
    const error = await create(name, extra).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CreateClientError);
    return error as CreateClientError;
  }

  const listing = () => readdirSync(inbox).sort();

  it('makes the client folder and its _Style, and nothing else', async () => {
    expect(await create('Kova Coffee')).toBe('Kova Coffee');

    expect(listing()).toEqual(['Kova Coffee']);
    expect(readdirSync(join(inbox, 'Kova Coffee'))).toEqual(['_Style']);
    expect(readdirSync(join(inbox, 'Kova Coffee', '_Style'))).toEqual([]);
  });

  it('writes the name trimmed and in NFC', async () => {
    const nfd = 'Café Müller'.normalize('NFD');

    const name = await create(`  ${nfd}\n`);

    expect(name).toBe('Café Müller'.normalize('NFC'));
    expect(listing().map((entry) => entry.normalize('NFC'))).toEqual([name]);
  });

  it('adds the folder to the list and announces it, once', async () => {
    await create('Kova Coffee');

    expect(folders.list()).toEqual(['Kova Coffee']);
    expect(events).toEqual([
      { type: 'client.added', clientId: clientIdFor('Kova Coffee'), client: 'Kova Coffee' },
    ]);
  });

  it('does not announce a folder the watcher found first', async () => {
    // The watcher can be quicker than the route: it lists the folder before the route adds it.
    mkdirSync(join(inbox, 'Kova Coffee'));
    folders.add('Kova Coffee');
    events.length = 0;
    rmSync(join(inbox, 'Kova Coffee'), { recursive: true });

    await create('Kova Coffee');

    expect(events).toEqual([]);
    expect(folders.list()).toEqual(['Kova Coffee']);
  });

  it('never makes a job', async () => {
    await create('Kova Coffee');
    await create('מאפיית הצפון');

    expect(jobs.getAll()).toEqual([]);
    expect(jobs.clientNames()).toEqual([]);
    // The only folder inside a client is _Style, which the scanner never takes for a job.
    expect(readdirSync(join(inbox, 'מאפיית הצפון'))).toEqual(['_Style']);
  });

  it('keeps Hebrew and emoji names as they are', async () => {
    expect(await create('מאפיית הצפון 🍞')).toBe('מאפיית הצפון 🍞');
    expect(listing()).toEqual(['מאפיית הצפון 🍞']);
  });

  describe('a name it refuses: 400, with a plain message, and nothing made', () => {
    it.each([
      ['', 'Give the client a name.'],
      ['   ', 'Give the client a name.'],
      ['x'.repeat(81), 'at most 80 characters'],
      ['Acme/Spring', 'contain / or :'],
      ['Acme: Spring', 'contain / or :'],
      ['.hidden', 'start with . or _'],
      ['..', 'start with . or _'],
      ['_Style', 'start with . or _'],
      ['_Exports', 'start with . or _'],
    ])('%j', async (name, words) => {
      const error = await refusal(name);

      expect(error.status).toBe(400);
      expect(error.message).toContain(words);
      expect(listing()).toEqual([]);
      expect(events).toEqual([]);
    });

    it('a name the configured exports folder has', async () => {
      const error = await refusal('Finished', { exportsDir: join(inbox, 'Finished') });

      expect(error.status).toBe(400);
      expect(error.message).toContain('kept for the engine');
      expect(listing()).toEqual([]);
    });
  });

  describe('a name that is taken: 409', () => {
    it('by a client folder', async () => {
      mkdirSync(join(inbox, 'Kova Coffee'));

      const error = await refusal('Kova Coffee');

      expect(error.status).toBe(409);
      expect(error.message).toContain('Kova Coffee');
      expect(events).toEqual([]);
    });

    it('by a client folder the disk lists decomposed (NFD), for the composed (NFC) name', async () => {
      mkdirSync(join(inbox, 'Café Müller'.normalize('NFD')));

      const error = await refusal('Café Müller'.normalize('NFC'));

      expect(error.status).toBe(409);
      expect(events).toEqual([]);
    });

    it('by a client folder the disk lists composed (NFC), for the decomposed (NFD) name', async () => {
      mkdirSync(join(inbox, 'Café Müller'.normalize('NFC')));

      const error = await refusal('Café Müller'.normalize('NFD'));

      expect(error.status).toBe(409);
      expect(events).toEqual([]);
    });

    it('by a file', async () => {
      writeFileSync(join(inbox, 'Kova Coffee'), 'x');

      const error = await refusal('Kova Coffee');

      expect(error.status).toBe(409);
      expect(readdirSync(inbox)).toEqual(['Kova Coffee']);
    });

    it('by a folder made just before: two calls at once make one client', async () => {
      const results = await Promise.allSettled([create('Kova Coffee'), create('Kova Coffee')]);

      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find((result) => result.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(events).toHaveLength(1);
      expect(readdirSync(join(inbox, 'Kova Coffee'))).toEqual(['_Style']);
    });
  });

  it('does not go by the list of folders, which can lag behind a delete in Finder', async () => {
    folders.add('Kova Coffee');

    expect(await create('Kova Coffee')).toBe('Kova Coffee');
    expect(listing()).toEqual(['Kova Coffee']);
  });

  it('fails with a 500, and brings nothing back, when the inbox folder is missing', async () => {
    rmSync(inbox, { recursive: true, force: true });

    const error = await refusal('Kova Coffee');

    expect(error.status).toBe(500);
    expect(error.message).toContain('inbox folder is missing');
    expect(() => readdirSync(inbox)).toThrow();
    expect(events).toEqual([]);
  });
});
