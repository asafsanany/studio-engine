import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiErrorSchema, clientStyleSchema } from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { StyleDrops } from '../clients/style-drops.js';
import type { StylePass } from '../clients/style-pass.js';
import type { StyleRunner } from '../clients/style-run.js';
import { StyleWorker } from '../clients/style-worker.js';
import { ClientStyleRepository, JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import type { Timers } from '../inbox/watcher.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The style routes (Read pass) over the real repositories (in memory), a temp inbox and a real
// style worker that is never started, so a queued pass stays queued and can be looked at. Finder
// drops are a real StyleDrops on hand-driven timers.

const KOVA = 'Kova Coffee';
const LIMIT = 1_000;

let inbox: string;
let db: StudioDb;
let jobs: JobRepository;
let clientStyles: ClientStyleRepository;
let worker: StyleWorker;
let timers: HandTimers;
let dropped: { client: string; pass: StylePass }[];
let drops: StyleDrops;
let app: Hono;

/** Timers the test fires by hand. */
class HandTimers implements Timers {
  readonly pending = new Map<number, () => void>();
  private next = 1;
  setTimeout(callback: () => void): unknown {
    this.pending.set(this.next, callback);
    return this.next++;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  fireAll(): void {
    for (const [handle, callback] of [...this.pending]) {
      this.pending.delete(handle);
      callback();
    }
  }
}

const neverRuns: StyleRunner = {
  run: async () => {
    throw new Error('the worker is not started in these tests');
  },
};

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-style-files-'));
  db = memoryDb();
  jobs = new JobRepository(db);
  clientStyles = new ClientStyleRepository(db);
  worker = new StyleWorker({
    clientStyles,
    inboxPath: inbox,
    dataDir: join(inbox, '.data'),
    runner: neverRuns,
  });
  timers = new HandTimers();
  dropped = [];
  drops = new StyleDrops({
    inboxPath: inbox,
    settleMs: 60_000,
    timers,
    enqueue: async (client, pass) => {
      dropped.push({ client, pass });
    },
  });
  app = createApp({
    clients: {
      jobs,
      clientStyles,
      inboxPath: inbox,
      openFolder: async () => {},
      styles: { worker, uploads: drops, maxUploadBytes: LIMIT },
    },
  });
});

afterEach(() => {
  drops.stop();
  if (db.sqlite.open) db.close();
  rmSync(inbox, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** A client the app knows (it has a job), with its folder and `_Style` on disk. */
function client(name: string): string {
  jobs.upsertFromScan(makeScan(name, 'Spring'));
  mkdirSync(join(inbox, name, 'Spring'), { recursive: true });
  mkdirSync(styleDir(name), { recursive: true });
  return clientIdFor(name);
}

const styleDir = (name: string) => join(inbox, name, '_Style');

function upload(clientId: string, files: Record<string, string>, mode?: string): Promise<Response> {
  const body = new FormData();
  for (const [name, content] of Object.entries(files))
    body.append('files[]', new File([content], name));
  if (mode !== undefined) body.append('mode', mode);
  return Promise.resolve(
    app.request(`/api/clients/${clientId}/style/files`, { method: 'POST', body }),
  );
}

const retry = (clientId: string) =>
  Promise.resolve(app.request(`/api/clients/${clientId}/style/retry`, { method: 'POST' }));

/** What is in `_Style`, staging folders included, sorted. */
const listing = (name: string) => readdirSync(styleDir(name)).sort();

describe('POST /api/clients/:clientId/style/files', () => {
  it('copies the files into _Style and queues a create pass when there is no style.md', async () => {
    const id = client(KOVA);

    const res = await upload(id, { 'logo.png': 'png', 'notes.txt': 'Warm, calm.' }, 'replace');

    expect(res.status).toBe(200);
    expect(clientStyleSchema.parse(await res.json())).toMatchObject({
      clientId: id,
      client: KOVA,
      state: 'analysing',
      version: 0,
      error: null,
    });
    expect(listing(KOVA)).toEqual(['logo.png', 'notes.txt']);
    expect(readFileSync(join(styleDir(KOVA), 'notes.txt'), 'utf8')).toBe('Warm, calm.');
    expect(clientStyles.get(id)?.lastPass).toEqual({
      kind: 'read',
      mode: 'create',
      files: [
        { name: 'logo.png', size: 3 },
        { name: 'notes.txt', size: 11 },
      ],
    });
  });

  it('adds or replaces as asked once there is a style.md, add when no mode is sent', async () => {
    for (const [name, mode, expected] of [
      ['Replace Co', 'replace', 'replace'],
      ['Add Co', 'add', 'add'],
      ['Default Co', undefined, 'add'],
    ] as const) {
      const id = client(name);
      writeFileSync(join(styleDir(name), 'style.md'), `# Style: ${name}\n`);
      clientStyles.upsert({ clientId: id, client: name, state: 'ready', version: 1 });
      expect((await upload(id, { 'a.png': 'a' }, mode)).status).toBe(200);
      expect(clientStyles.get(id)?.lastPass, name).toMatchObject({ mode: expected });
    }
  });

  it('gives a name that is already taken " (1)", and never overwrites style.md', async () => {
    const id = client(KOVA);
    writeFileSync(join(styleDir(KOVA), 'logo.png'), 'the old logo');

    await upload(id, { 'logo.png': 'the new logo', 'style.md': 'not a style' });

    expect(listing(KOVA)).toEqual(['logo (1).png', 'logo.png', 'style (1).md']);
    expect(readFileSync(join(styleDir(KOVA), 'logo.png'), 'utf8')).toBe('the old logo');
    expect(readFileSync(join(styleDir(KOVA), 'logo (1).png'), 'utf8')).toBe('the new logo');
    expect(clientStyles.get(id)?.lastPass).toMatchObject({
      files: [
        { name: 'logo (1).png', size: 12 },
        { name: 'style (1).md', size: 11 },
      ],
    });
  });

  it('answers 404 for an unknown client, and for one whose folder is gone', async () => {
    const res = await upload('000000000000', { 'a.png': 'a' });
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error).toBe('Client 000000000000 not found');

    const id = client(KOVA);
    rmSync(join(inbox, KOVA), { recursive: true });
    const gone = await upload(id, { 'a.png': 'a' });
    expect(gone.status).toBe(404);
    expect(existsSync(join(inbox, KOVA))).toBe(false);
  });

  it('answers 409 while the client is analysing, and keeps nothing', async () => {
    const id = client(KOVA);
    expect((await upload(id, { 'a.png': 'a' })).status).toBe(200);

    const res = await upload(id, { 'b.png': 'b' });

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/being analysed/);
    expect(listing(KOVA)).toEqual(['a.png']);
  });

  it('answers 413 above the limit in all, leaving nothing behind and queuing nothing', async () => {
    const id = client(KOVA);

    const res = await upload(id, { 'a.mov': 'x'.repeat(600), 'b.mov': 'y'.repeat(600) });

    expect(res.status).toBe(413);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/larger than 2 GB/);
    expect(listing(KOVA)).toEqual([]);
    expect(clientStyles.get(id)).toBeNull();
  });

  it('answers 413 at once when the request says it is too large', async () => {
    const id = client(KOVA);
    const res = await app.request(`/api/clients/${id}/style/files`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '5000' },
      body: 'x'.repeat(5_000),
    });
    expect(res.status).toBe(413);
    expect(listing(KOVA)).toEqual([]);
  });

  it('answers 400 without files, with another mode, or for a body that is not multipart', async () => {
    const id = client(KOVA);
    expect((await upload(id, {}, 'add')).status).toBe(400);
    const odd = await upload(id, { 'a.png': 'a' }, 'merge');
    expect(odd.status).toBe(400);
    expect(apiErrorSchema.parse(await odd.json()).error).toBe('The mode must be add or replace.');
    const json = await app.request(`/api/clients/${id}/style/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(400);
    expect(listing(KOVA)).toEqual([]);
    expect(clientStyles.get(id)).toBeNull();
  });

  it('does not also make a Finder Read pass of the files it put in _Style', async () => {
    const id = client(KOVA);
    await upload(id, { 'logo.png': 'png', 'notes.txt': 'n' });

    // What chokidar reports for the two renames, plus a real drop next to them.
    writeFileSync(join(styleDir(KOVA), 'brief.pdf'), 'pdf');
    for (const path of ['logo.png', 'notes.txt', 'brief.pdf']) {
      drops.notify({ kind: 'add', client: KOVA, path });
    }
    timers.fireAll();
    await drops.whenIdle();

    expect(dropped).toEqual([
      {
        client: KOVA,
        pass: { kind: 'read', mode: 'add', files: [{ name: 'brief.pdf', size: 3 }] },
      },
    ]);
  });
});

describe('POST /api/clients/:clientId/style/retry', () => {
  it('answers 404 for an unknown client', async () => {
    expect((await retry('000000000000')).status).toBe(404);
  });

  it('answers 409 unless the style failed', async () => {
    const id = client(KOVA);
    expect((await retry(id)).status).toBe(409);
    clientStyles.upsert({ clientId: id, client: KOVA, state: 'ready', version: 1 });
    const res = await retry(id);
    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/has not failed/);
  });

  it('queues the failed pass again and answers the style, analysing', async () => {
    const id = client(KOVA);
    writeFileSync(join(styleDir(KOVA), 'logo.png'), 'png');
    const lastPass = { kind: 'read', mode: 'create', files: [{ name: 'logo.png', size: 3 }] };
    clientStyles.upsert({
      clientId: id,
      client: KOVA,
      state: 'failed',
      error: 'Style stopped: the style took longer than 10 minutes.',
      lastPass,
    });

    const res = await retry(id);

    expect(res.status).toBe(200);
    expect(clientStyleSchema.parse(await res.json())).toMatchObject({
      state: 'analysing',
      error: null,
    });
    expect(clientStyles.get(id)?.lastPass).toEqual(lastPass);
  });
});

describe('POST /api/clients/:clientId/style/undo', () => {
  const undo = (clientId: string) =>
    Promise.resolve(app.request(`/api/clients/${clientId}/style/undo`, { method: 'POST' }));
  const history = (clientId: string) => join(inbox, '.data', 'clients', clientId, 'history');

  it('answers 404 for an unknown client', async () => {
    expect((await undo('000000000000')).status).toBe(404);
  });

  it('answers 409 when no earlier style was kept', async () => {
    const id = client(KOVA);
    writeFileSync(join(styleDir(KOVA), 'style.md'), '# Style: Kova Coffee\n');

    const res = await undo(id);

    expect(res.status).toBe(409);
    expect(apiErrorSchema.parse(await res.json()).error).toBe(
      'There is no earlier style to go back to.',
    );
  });

  it('answers 409 while the client is analysing', async () => {
    const id = client(KOVA);
    mkdirSync(history(id), { recursive: true });
    writeFileSync(join(history(id), '1.md'), '# Style: Kova Coffee\nold\n');
    clientStyles.upsert({ clientId: id, client: KOVA, state: 'analysing', version: 2 });

    expect((await undo(id)).status).toBe(409);
  });

  it('puts the newest kept style back and answers the style, one version on', async () => {
    const id = client(KOVA);
    writeFileSync(join(styleDir(KOVA), 'style.md'), '# Style: Kova Coffee\nnew\n');
    mkdirSync(history(id), { recursive: true });
    writeFileSync(join(history(id), '1.md'), '# Style: Kova Coffee\nold\n');
    writeFileSync(join(history(id), '1.json'), '{"sourceJobId":"a1b2c3d4e5f6"}');
    clientStyles.upsert({ clientId: id, client: KOVA, state: 'ready', version: 2 });

    const res = await undo(id);

    expect(res.status).toBe(200);
    expect(clientStyleSchema.parse(await res.json())).toMatchObject({
      clientId: id,
      state: 'ready',
      version: 3,
      sourceJobId: 'a1b2c3d4e5f6',
      pass: null,
    });
    expect(readFileSync(join(styleDir(KOVA), 'style.md'), 'utf8')).toBe(
      '# Style: Kova Coffee\nold\n',
    );
    expect(readFileSync(join(history(id), '2.md'), 'utf8')).toBe('# Style: Kova Coffee\nnew\n');
  });
});
