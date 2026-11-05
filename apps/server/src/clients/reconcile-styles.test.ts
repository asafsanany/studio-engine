import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerEvent } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository, type StudioDb } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { reconcileClientStyles } from './reconcile-styles.js';

// The real file system under a temp inbox; the real repository on an in-memory database.

let inbox: string;
let exportsDir: string;
let db: StudioDb;
let repo: ClientStyleRepository;
let events: ServerEvent[];
let bus: ReturnType<typeof createEventBus>;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-styles-'));
  exportsDir = join(inbox, '_Exports');
  db = memoryDb();
  repo = new ClientStyleRepository(db);
  bus = createEventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
});

afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(inbox, { recursive: true, force: true });
});

/** Writes `<inbox>/<client>/_Style/style.md` with the given modification time. */
function styleFile(
  client: string,
  mtime = '2026-10-18T09:30:00.000Z',
  text = `# Style: ${client}\n`,
) {
  const path = join(inbox, client, '_Style', 'style.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const when = new Date(mtime);
  utimesSync(path, when, when);
  return path;
}

const reconcile = () => reconcileClientStyles({ inboxPath: inbox, exportsDir, repo, bus });

describe('reconcileClientStyles', () => {
  it('gives a client with a style.md and no record the state ready, version 1 and the time of the file', async () => {
    styleFile('Kova Coffee', '2026-10-18T09:30:00.000Z');

    const added = await reconcile();

    expect(added).toBe(1);
    expect(repo.get(clientIdFor('Kova Coffee'))).toEqual({
      clientId: clientIdFor('Kova Coffee'),
      client: 'Kova Coffee',
      state: 'ready',
      version: 1,
      updatedAt: '2026-10-18T09:30:00.000Z',
      error: null,
      sourceJobId: null,
      lastPass: null,
    });
  });

  it('tells the browsers about the new record, without the markdown', async () => {
    styleFile('Kova Coffee');

    await reconcile();

    expect(events).toEqual([
      {
        type: 'client.upsert',
        style: {
          clientId: clientIdFor('Kova Coffee'),
          client: 'Kova Coffee',
          state: 'ready',
          version: 1,
          updatedAt: '2026-10-18T09:30:00.000Z',
          error: null,
          sourceJobId: null,
          pass: null,
        },
      },
    ]);
  });

  it('does it for every such client, and for a client that has no job at all', async () => {
    styleFile('Arc Fitness');
    styleFile('Kova Coffee');
    styleFile('מאפיית הצפון');

    expect(await reconcile()).toBe(3);
    expect(
      repo
        .list()
        .map((style) => style.client)
        .sort(),
    ).toEqual(['Arc Fitness', 'Kova Coffee', 'מאפיית הצפון']);
  });

  it('adds nothing for a client without a style.md: no _Style, an empty one, or a style.md that is a folder', async () => {
    mkdirSync(join(inbox, 'No Style'), { recursive: true });
    mkdirSync(join(inbox, 'Empty Style', '_Style'), { recursive: true });
    mkdirSync(join(inbox, 'Odd Style', '_Style', 'style.md'), { recursive: true });

    expect(await reconcile()).toBe(0);
    expect(repo.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('leaves a client that has a record alone, whatever the file says', async () => {
    styleFile('Kova Coffee', '2026-10-18T09:30:00.000Z');
    repo.upsert({
      clientId: clientIdFor('Kova Coffee'),
      client: 'Kova Coffee',
      state: 'analysing',
      version: 4,
      updatedAt: '2026-10-19T10:00:00.000Z',
      sourceJobId: 'a1b2c3d4e5f6',
    });
    const before = repo.get(clientIdFor('Kova Coffee'));

    expect(await reconcile()).toBe(0);

    expect(repo.get(clientIdFor('Kova Coffee'))).toEqual(before);
    expect(events).toEqual([]);
  });

  it('does nothing the second time', async () => {
    styleFile('Kova Coffee');
    await reconcile();
    events.length = 0;

    expect(await reconcile()).toBe(0);
    expect(repo.list()).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('is the same client in the NFC and NFD spellings of its name', async () => {
    const nfc = 'Café';
    styleFile(nfc.normalize('NFD'));
    repo.upsert({ clientId: clientIdFor(nfc), client: nfc, state: 'ready', version: 2 });

    expect(await reconcile()).toBe(0);
    expect(repo.list()).toHaveLength(1);
  });

  it('skips what is not a client folder: _Exports, dot-folders, links and the configured exports folder', async () => {
    styleFile('_Exports');
    styleFile('.hidden');
    styleFile('Finished');
    const elsewhere = mkdtempSync(join(tmpdir(), 'studio-styles-elsewhere-'));
    try {
      mkdirSync(join(elsewhere, '_Style'));
      writeFileSync(join(elsewhere, '_Style', 'style.md'), '# Style: Linked\n');
      symlinkSync(elsewhere, join(inbox, 'Linked'));

      expect(
        await reconcileClientStyles({
          inboxPath: inbox,
          exportsDir: join(inbox, 'Finished'),
          repo,
          bus,
        }),
      ).toBe(0);
      expect(repo.list()).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('adds nothing when the inbox does not exist', async () => {
    const missing = join(inbox, 'nowhere');
    expect(
      await reconcileClientStyles({
        inboxPath: missing,
        exportsDir: join(missing, '_Exports'),
        repo,
        bus,
      }),
    ).toBe(0);
    expect(repo.list()).toEqual([]);
  });

  it('carries on with the other clients when one record cannot be written, and says so', async () => {
    styleFile('Arc Fitness');
    styleFile('Kova Coffee');
    const warnings: string[] = [];
    const logger = {
      info() {},
      warn: (_obj: object, msg?: string) => void warnings.push(msg ?? ''),
    };
    const failing = {
      get: repo.get.bind(repo),
      upsert: (input: Parameters<typeof repo.upsert>[0]) => {
        if (input.client === 'Arc Fitness') throw new Error('disk full');
        return repo.upsert(input);
      },
    };

    const added = await reconcileClientStyles({
      inboxPath: inbox,
      exportsDir,
      repo: failing,
      bus,
      logger,
    });

    expect(added).toBe(1);
    expect(repo.list().map((style) => style.client)).toEqual(['Kova Coffee']);
    expect(warnings).toEqual(['could not record the style of a client']);
  });
});
