import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  apiErrorSchema,
  clientStyleResponseSchema,
  jobSchema,
  revealClientResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { ClientStyleRepository, JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import { logger } from '../logger.js';
import { type FolderOpener, openInFinder } from './clients.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The real repositories on an in-memory database, the real routes over a temp inbox, `app.request`
// for the HTTP. Only the folder opener is a stand-in: no test ever opens Finder.

let inbox: string;
let db: StudioDb;
let jobs: JobRepository;
let clientStyles: ClientStyleRepository;
let app: Hono;
let opened: string[];
let openFolder: FolderOpener;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-clients-'));
  db = memoryDb();
  jobs = new JobRepository(db);
  clientStyles = new ClientStyleRepository(db);
  opened = [];
  openFolder = async (path) => {
    opened.push(path);
  };
  app = buildApp();
});

afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(inbox, { recursive: true, force: true });
  vi.clearAllMocks();
});

function buildApp(overrides: { openFolder?: FolderOpener } = {}): Hono {
  return createApp({
    clients: {
      jobs,
      clientStyles,
      inboxPath: inbox,
      openFolder: overrides.openFolder ?? openFolder,
    },
  });
}

/** A client the app knows (it has a job) with its folder on disk. */
function client(name: string): string {
  jobs.upsertFromScan(makeScan(name, 'Spring'));
  mkdirSync(join(inbox, name, 'Spring'), { recursive: true });
  return clientIdFor(name);
}

function writeStyle(name: string, text: string): string {
  const path = join(inbox, name, '_Style', 'style.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

async function getStyle(clientId: string) {
  return app.request(`/api/clients/${clientId}/style`);
}

async function reveal(clientId: string, application: Hono = app) {
  return application.request(`/api/clients/${clientId}/reveal`, { method: 'POST' });
}

describe('GET /api/clients/:clientId/style', () => {
  it('answers state none for a client that has no style, with no markdown', async () => {
    const id = client('Arc Fitness');

    const res = await getStyle(id);

    expect(res.status).toBe(200);
    const body = clientStyleResponseSchema.parse(await res.json());
    expect(body).toEqual({
      clientId: id,
      client: 'Arc Fitness',
      state: 'none',
      version: 0,
      updatedAt: null,
      error: null,
      sourceJobId: null,
      pass: null,
      markdown: null,
    });
  });

  it('answers a ready style with its row and the text of style.md', async () => {
    const id = client('Kova Coffee');
    const markdown =
      '# Style: Kova Coffee\nLearned from Menu (2026-10-18).\n\n## Look\n- Colours: espresso #3B2A20\n';
    writeStyle('Kova Coffee', markdown);
    clientStyles.upsert({
      clientId: id,
      client: 'Kova Coffee',
      state: 'ready',
      version: 2,
      updatedAt: '2026-10-18T09:30:00.000Z',
      sourceJobId: 'a1b2c3d4e5f6',
    });

    const res = await getStyle(id);

    expect(res.status).toBe(200);
    expect(clientStyleResponseSchema.parse(await res.json())).toEqual({
      clientId: id,
      client: 'Kova Coffee',
      state: 'ready',
      version: 2,
      updatedAt: '2026-10-18T09:30:00.000Z',
      error: null,
      sourceJobId: 'a1b2c3d4e5f6',
      pass: null,
      markdown,
    });
  });

  it('answers the markdown byte for byte, Hebrew included, and never the lastPass', async () => {
    const id = client('מאפיית הצפון');
    const markdown = '# Style: מאפיית הצפון\r\n\r\n- Don’t: …  \n';
    writeStyle('מאפיית הצפון', markdown);
    clientStyles.upsert({
      clientId: id,
      client: 'מאפיית הצפון',
      state: 'failed',
      version: 1,
      error: 'Style stopped: it timed out',
      lastPass: { kind: 'read', files: ['logo.png'] },
    });

    const body = (await (await getStyle(id)).json()) as Record<string, unknown>;

    expect(body.markdown).toBe(markdown);
    expect(body.error).toBe('Style stopped: it timed out');
    expect(body).not.toHaveProperty('lastPass');
    expect(Object.keys(body).sort()).toEqual(
      [
        'clientId',
        'client',
        'state',
        'version',
        'updatedAt',
        'error',
        'sourceJobId',
        'pass',
        'markdown',
      ].sort(),
    );
  });

  it('answers markdown null while style.md is not there, also when the state says ready', async () => {
    const id = client('Kova Coffee');
    mkdirSync(join(inbox, 'Kova Coffee', '_Style'));
    clientStyles.upsert({ clientId: id, client: 'Kova Coffee', state: 'ready', version: 1 });

    const body = clientStyleResponseSchema.parse(await (await getStyle(id)).json());

    expect(body.state).toBe('ready');
    expect(body.markdown).toBeNull();
  });

  it('reads style.md also for a client with no record yet (written by hand after the boot)', async () => {
    const id = client('Kova Coffee');
    writeStyle('Kova Coffee', '# Style: Kova Coffee\n');

    const body = clientStyleResponseSchema.parse(await (await getStyle(id)).json());

    expect(body).toMatchObject({ state: 'none', version: 0, markdown: '# Style: Kova Coffee\n' });
  });

  it('answers an empty style.md as an empty string, not null', async () => {
    const id = client('Kova Coffee');
    writeStyle('Kova Coffee', '');

    expect((await (await getStyle(id)).json()) as { markdown: unknown }).toMatchObject({
      markdown: '',
    });
  });

  it('answers markdown null when style.md is a folder', async () => {
    const id = client('Kova Coffee');
    mkdirSync(join(inbox, 'Kova Coffee', '_Style', 'style.md'), { recursive: true });

    expect(await (await getStyle(id)).json()).toMatchObject({ markdown: null });
  });

  it('knows a client by its record when its last job is gone, and names it as the record does', async () => {
    const id = clientIdFor('Old Client');
    clientStyles.upsert({ clientId: id, client: 'Old Client', state: 'ready', version: 3 });
    writeStyle('Old Client', '# Style: Old Client\n');

    const res = await getStyle(id);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      client: 'Old Client',
      state: 'ready',
      version: 3,
      markdown: '# Style: Old Client\n',
    });
  });

  it('answers 404 with an error body for a client nobody knows', async () => {
    client('Arc Fitness');

    for (const unknown of [clientIdFor('Nobody'), '000000000000', 'not-an-id']) {
      const res = await getStyle(unknown);
      expect(res.status, unknown).toBe(404);
      expect(apiErrorSchema.parse(await res.json())).toEqual({
        error: `Client ${unknown} not found`,
      });
    }
  });

  it('answers 404 before any job exists', async () => {
    expect((await getStyle(clientIdFor('Arc Fitness'))).status).toBe(404);
  });

  it('only reads the style of the client in the URL', async () => {
    const arc = client('Arc Fitness');
    client('Kova Coffee');
    writeStyle('Kova Coffee', '# Style: Kova Coffee\n');

    expect(await (await getStyle(arc)).json()).toMatchObject({
      client: 'Arc Fitness',
      markdown: null,
    });
  });

  it('is not mounted by an app that was built without the clients routes', async () => {
    const bare = createApp();
    const res = await bare.request(`/api/clients/${clientIdFor('Arc Fitness')}/style`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/clients/:clientId/reveal', () => {
  it('opens the client folder in Finder through the opener, and nothing else', async () => {
    const id = client('Arc Fitness');
    client('Kova Coffee');

    const res = await reveal(id);

    expect(res.status).toBe(200);
    expect(revealClientResponseSchema.parse(await res.json())).toEqual({ ok: true });
    expect(opened).toEqual([join(inbox, 'Arc Fitness')]);
  });

  it('opens the folder of a client with a Hebrew name exactly as the job lists it', async () => {
    const id = client('מאפיית הצפון');

    await reveal(id);

    expect(opened).toEqual([join(inbox, 'מאפיית הצפון')]);
  });

  it('opens a client that is known only by its record', async () => {
    mkdirSync(join(inbox, 'Old Client'));
    const id = clientIdFor('Old Client');
    clientStyles.upsert({ clientId: id, client: 'Old Client', state: 'ready', version: 1 });

    expect((await reveal(id)).status).toBe(200);
    expect(opened).toEqual([join(inbox, 'Old Client')]);
  });

  it('answers 404 for an unknown client and opens nothing', async () => {
    client('Arc Fitness');

    const res = await reveal(clientIdFor('Nobody'));

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toContain('not found');
    expect(opened).toEqual([]);
  });

  it('answers 404 when the client folder is gone, and opens nothing', async () => {
    const id = client('Arc Fitness');
    rmSync(join(inbox, 'Arc Fitness'), { recursive: true });

    const res = await reveal(id);

    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      error: 'The client folder is missing.',
    });
    expect(opened).toEqual([]);
  });

  it('answers 500 with an error body, and logs, when Finder cannot be asked', async () => {
    const id = client('Arc Fitness');
    const failing = buildApp({
      openFolder: async () => {
        throw new Error('spawn open ENOENT');
      },
    });

    const res = await reveal(id, failing);

    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json())).toEqual({
      error: 'Could not open the folder in Finder.',
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('is a POST only', async () => {
    const id = client('Arc Fitness');

    const res = await app.request(`/api/clients/${id}/reveal`);

    expect(res.status).toBe(404);
    expect(opened).toEqual([]);
  });
});

describe('every API response with jobs carries clientId', () => {
  it('GET /api/jobs lists each job with the id of its client folder', async () => {
    const jobsApp = createApp({
      jobs: { jobs, worker: null, exportsDir: join(inbox, '_Exports') },
    });
    jobs.upsertFromScan(makeScan('Arc Fitness', 'Spring'));
    jobs.upsertFromScan(makeScan('Arc Fitness', 'Summer'));
    jobs.upsertFromScan(makeScan('מאפיית הצפון', 'סרטון'));

    const res = await jobsApp.request('/api/jobs');
    const list = (await res.json()) as unknown[];

    expect(list).toHaveLength(3);
    for (const entry of list) {
      const job = jobSchema.parse(entry);
      expect(job.clientId).toBe(clientIdFor(job.client));
    }
    expect(new Set(list.map((entry) => (entry as { clientId: string }).clientId)).size).toBe(2);
  });
});

// The real opener, with a stand-in `open` first on the PATH: Finder is never asked.
describe.skipIf(process.platform === 'win32')('openInFinder', () => {
  let bin: string;
  let log: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'studio-fake-open-'));
    log = join(bin, 'args.log');
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('FAKE_OPEN_LOG', log);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });

  function fakeOpen(script: string): void {
    const path = join(bin, 'open');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }

  it('runs open with the folder as its one argument, spaces and Hebrew intact', async () => {
    fakeOpen('printf "%s\\n" "$#" "$1" > "$FAKE_OPEN_LOG"');

    await openInFinder('/Studio Inbox/מאפיית הצפון');

    expect(readFileSync(log, 'utf8')).toBe('1\n/Studio Inbox/מאפיית הצפון\n');
  });

  it('fails when open does', async () => {
    fakeOpen('exit 1');

    await expect(openInFinder('/Studio Inbox/Acme')).rejects.toThrow();
  });
});
