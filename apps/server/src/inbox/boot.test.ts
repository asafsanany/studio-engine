import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Job, ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientFolders } from '../clients/client-folders.js';
import { ClientStyleRepository, JobRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { type RunningInbox, startInbox } from './boot.js';
import { DurationCache } from './probe.js';
import { clientIdFor, scanJob } from './scan.js';
import { FOLDER_REMOVED_ERROR, type FsEvent, type FsEventSource } from './watcher.js';

// The inbox side of the boot against the real file system and the real chokidar: reconcile, start
// the watcher, arm the timers. Real time, so the numbers are small but generous, and every wait for
// something to happen is a poll with a deadline: a slow machine makes the tests slower, not flaky.

const SETTLE_MS = 700;
const DEBOUNCE_MS = 40;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `read` until it returns something truthy, or fails with `what` after the deadline. */
async function waitFor<T>(
  read: () => T | null | undefined | false,
  what: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(20);
  }
}

// A file made just before a boot can still be reported by the real watcher (macOS delivers file
// events in batches) after the boot has finished. The watcher then treats the folder as active and
// restarts its settle timer, which is right for the product but would make a test about "quiet for
// 5 s" depend on timing. Only the tests that are about watching use the real one (`startWatching`).
const quietSource: FsEventSource = { start: async () => {}, stop: async () => {} };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  // Straight from tmpdir(): on macOS that sits behind the /var -> /private/var link, which a
  // linked inbox folder (Dropbox, an external drive) does in real life too.
  const base = mkdtempSync(join(tmpdir(), 'studio-boot-'));
  const inbox = join(base, 'Studio Inbox');
  const exportsDir = join(inbox, '_Exports');
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));

  const db = memoryDb();
  const repo = new JobRepository(db);
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const durations = new DurationCache(async () => null);
  const config = { inboxPath: inbox, exportsDir, settleMs: SETTLE_MS };

  const put = (client: string, name: string, rel: string, size = 10) => {
    const path = join(inbox, client, name, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.alloc(size, 1));
  };

  /** A job as the engine would have stored it `agoMs` ago: its repository's clock is set back. */
  const seed = async (client: string, name: string, agoMs: number, present = true) => {
    const past = new JobRepository(db, { clock: () => new Date(Date.now() - agoMs) });
    const relPath = `${client}/${name}`;
    const scan = present ? await scanJob(inbox, client, name, { exportsDir, durations }) : null;
    return past.upsertFromScan(
      scan ?? {
        id: relPath,
        client,
        name,
        relPath,
        inputs: { video: 1, audio: 0, image: 0, doc: 0 },
        sizeBytes: 10,
        footageSec: 0,
      },
    ).job;
  };

  const boot = async (
    options: Partial<Parameters<typeof startInbox>[0]> = {},
  ): Promise<RunningInbox> => {
    const running = await startInbox({
      config,
      repo,
      bus,
      durations,
      debounceMs: DEBOUNCE_MS,
      ...options,
    });
    cleanups.push(() => running.stop());
    return running;
  };

  /** Starts the inbox without any file events, so only what the test does to the repository counts. */
  const start = (options: Partial<Parameters<typeof startInbox>[0]> = {}) =>
    boot({ source: quietSource, ...options });

  /** Starts the inbox on the real file system and the real chokidar. */
  const startWatching = (options: Partial<Parameters<typeof startInbox>[0]> = {}) => boot(options);

  const state = (id: string) => repo.get(id)?.state;
  const byName = (name: string): Job | undefined => repo.getAll().find((job) => job.name === name);

  return {
    inbox,
    exportsDir,
    db,
    repo,
    bus,
    events,
    put,
    seed,
    start,
    startWatching,
    state,
    byName,
  };
}

describe('startInbox', () => {
  it('reconciles the disk first, then arms the timers of what is arriving', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Old', 'a.mp4');
    t.put('Acme', 'Fresh', 'a.mp4');
    const old = await t.seed('Acme', 'Old', 5 * 60_000);
    const gone = await t.seed('Acme', 'Gone', 5 * 60_000, false);

    const running = await t.start();

    expect(running.summary).toMatchObject({ created: 1, settled: 1, removed: 1, unchanged: 0 });
    expect(t.state(old.id)).toBe('queued');
    expect(t.repo.get(gone.id)).toBeNull();
    const fresh = t.byName('Fresh') as Job;
    expect(fresh.state).toBe('arriving');
    expect(t.events).toContainEqual({ type: 'job.remove', id: gone.id });

    // armAll(): the new job settles on its own timer, with no file event to prompt it.
    await waitFor(() => t.state(fresh.id) === 'queued', 'the new folder to settle');
    expect(t.events).toContainEqual({
      type: 'job.upsert',
      job: expect.objectContaining({ id: fresh.id, state: 'queued' }),
    });
  });

  it('queues at boot only what has been quiet for the configured settle time', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.seed('Acme', 'Spring', 10_000);
    // Quiet for 10 s, but the configured time is longer than that, so reconcile leaves it...
    const running = await t.start({ config: { ...configOf(t), settleMs: 60_000 } });
    expect(running.summary.settled).toBe(0);
    expect(t.state(job.id)).toBe('arriving');
    await running.stop();

    // ...and with a shorter one the next boot queues it straight away.
    const again = await t.start({ config: { ...configOf(t), settleMs: 5_000 } });
    expect(again.summary.settled).toBe(1);
    expect(t.state(job.id)).toBe('queued');
  });

  it('keeps a job left in editing exactly as it is', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.seed('Acme', 'Spring', 5 * 60_000);
    t.repo.applyTransition(job.id, { type: 'SETTLED' });
    const editing = t.repo.applyTransition(job.id, { type: 'START' });

    const running = await t.start();

    expect(running.summary).toMatchObject({ resuming: 1, unchanged: 0 });
    expect(t.repo.get(job.id)).toEqual(editing);
    expect(t.repo.getEditing().map((j) => j.id)).toEqual([job.id]);
  });

  it('warns about a new client folder while a job is being edited, through the injected source', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    const job = await t.seed('Acme', 'Spring', 5 * 60_000);
    t.repo.applyTransition(job.id, { type: 'SETTLED' });
    t.repo.applyTransition(job.id, { type: 'START' });

    let emit: (event: FsEvent) => void = () => {};
    const source: FsEventSource = {
      start: async (emitEvent) => {
        emit = emitEvent;
      },
      stop: async () => {},
    };
    const warnings: { obj: object; msg: string | undefined }[] = [];
    const logger = {
      debug() {},
      info() {},
      warn: (obj: object, msg?: string) => warnings.push({ obj, msg }),
      error() {},
    };
    await t.start({ source, logger });

    emit({ kind: 'addDir', path: join(t.inbox, 'package') });
    // Ordinary traffic does not warn: a file in the editing job, and what the engine itself writes.
    emit({ kind: 'add', path: join(t.inbox, 'Acme', 'Spring', 'b.mp4') });
    emit({ kind: 'addDir', path: join(t.exportsDir, 'Acme') });

    expect(warnings.filter((line) => line.msg?.includes('the edit may have written it'))).toEqual([
      {
        msg: expect.stringContaining('while an edit is running'),
        obj: { folder: 'package', editingJobId: job.id, editingRelPath: 'Acme/Spring' },
      },
    ]);
  });

  it('fails a job left in editing whose folder is gone and tells the hook', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    const job = await t.seed('Acme', 'Gone', 5 * 60_000, false);
    t.repo.applyTransition(job.id, { type: 'SETTLED' });
    t.repo.applyTransition(job.id, { type: 'START' });
    const told: Job[] = [];

    await t.start({ onFolderRemovedWhileEditing: (failed) => told.push(failed) });

    expect(t.repo.get(job.id)).toMatchObject({ state: 'failed', error: FOLDER_REMOVED_ERROR });
    expect(told.map((j) => j.id)).toEqual([job.id]);
  });

  it('watches the inbox once it has started', async () => {
    const t = setup();
    const running = await t.startWatching();
    expect(running.summary.created).toBe(0);

    t.put('Acme', 'Live', 'a.mp4');
    const live = await waitFor(() => t.byName('Live'), 'the new folder to be noticed');
    expect(live.state).toBe('arriving');

    await waitFor(() => t.state(live.id) === 'queued', 'the new folder to settle');
  });

  it('creates the inbox when it is not there yet', async () => {
    const t = setup();

    const running = await t.startWatching();

    expect(running.summary).toMatchObject({ created: 0, removed: 0, unchanged: 0 });
    expect(t.repo.getAll()).toEqual([]);
    t.put('Acme', 'First', 'a.mp4');
    await waitFor(() => t.byName('First'), 'a folder in the freshly created inbox');
  });

  it('stops watching on stop(), which is safe to call twice', async () => {
    const t = setup();
    const running = await t.startWatching();

    await running.stop();
    await running.stop();
    t.put('Acme', 'Late', 'a.mp4');
    await sleep(DEBOUNCE_MS * 10);

    expect(t.byName('Late')).toBeUndefined();
  });

  it('rejects, with nothing running, when the inbox path is a file', async () => {
    const t = setup();
    mkdirSync(dirname(t.inbox), { recursive: true });
    writeFileSync(t.inbox, 'not a folder');

    await expect(t.start()).rejects.toThrow();
    expect(t.events).toEqual([]);
  });

  it('rejects, and stops the watcher it made, when watching cannot start', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    const source: FsEventSource = {
      start: async () => {
        throw new Error('no file watching');
      },
      stop: async () => {},
    };

    await expect(t.start({ source })).rejects.toThrow('no file watching');

    // Reconciliation had already run.
    expect(t.byName('Spring')?.state).toBe('arriving');
  });
});

describe('startInbox: client styles', () => {
  it('makes every client folder a _Style folder, which is never a job', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    mkdirSync(join(t.inbox, 'Beta'));

    await t.start();

    expect(statSync(join(t.inbox, 'Acme', '_Style')).isDirectory()).toBe(true);
    expect(statSync(join(t.inbox, 'Beta', '_Style')).isDirectory()).toBe(true);
    expect(t.repo.getAll().map((job) => job.relPath)).toEqual(['Acme/Spring']);
  });

  it('adds a ready style record, version 1, from the time of a style.md found without one', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    const styleFile = join(t.inbox, 'Acme', '_Style', 'style.md');
    mkdirSync(dirname(styleFile), { recursive: true });
    writeFileSync(styleFile, '# Style: Acme\n');
    const mtime = new Date('2026-10-18T09:30:00.000Z');
    utimesSync(styleFile, mtime, mtime);
    const clientStyles = new ClientStyleRepository(t.db);

    await t.start({ clientStyles });

    expect(clientStyles.list()).toEqual([
      {
        clientId: clientIdFor('Acme'),
        client: 'Acme',
        state: 'ready',
        version: 1,
        updatedAt: mtime.toISOString(),
        error: null,
        sourceJobId: null,
        lastPass: null,
      },
    ]);
    expect(t.events).toContainEqual({
      type: 'client.upsert',
      style: expect.objectContaining({ clientId: clientIdFor('Acme'), state: 'ready', version: 1 }),
    });
  });

  it('reconciles the styles after the _Style folders exist, and a client without a style.md gets no record', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    const clientStyles = new ClientStyleRepository(t.db);

    await t.start({ clientStyles });

    expect(clientStyles.list()).toEqual([]);
    expect(existsSync(join(t.inbox, 'Acme', '_Style'))).toBe(true);
  });

  it('starts anyway, and says so, when a style record cannot be written', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    mkdirSync(join(t.inbox, 'Acme', '_Style'), { recursive: true });
    writeFileSync(join(t.inbox, 'Acme', '_Style', 'style.md'), '# Style: Acme\n');
    const clientStyles = new ClientStyleRepository(t.db);
    t.db.sqlite.exec('drop table client_styles');
    const warnings: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn: (_obj: object, msg?: string) => void warnings.push(msg ?? ''),
      error() {},
    };

    const running = await t.start({ clientStyles, logger });

    expect(running.summary.created).toBe(1);
    expect(t.byName('Spring')?.state).toBe('arriving');
    expect(warnings).toEqual(['could not record the style of a client']);
  });
});

describe('startInbox: client folders', () => {
  it('lists every client folder, with jobs or without, and none of what the inbox rules skip', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    mkdirSync(join(t.inbox, 'Empty Client'));
    mkdirSync(join(t.inbox, 'מאפיית הצפון'));
    mkdirSync(join(t.inbox, '.hidden'));
    mkdirSync(join(t.inbox, '_Fonts', 'Rubik'), { recursive: true });
    mkdirSync(t.exportsDir, { recursive: true });
    writeFileSync(join(t.inbox, 'notes.txt'), 'a file, not a client');
    const folders = new ClientFolders(t.bus);

    await t.start({ clientFolders: folders });

    expect(folders.list()).toEqual(['Acme', 'Empty Client', 'מאפיית הצפון']);
    expect(folders.find(clientIdFor('Empty Client'))).toBe('Empty Client');
    // Listing the folders at boot is not news: nobody is told about them.
    expect(t.events.filter((event) => event.type.startsWith('client.'))).toEqual([]);
    expect(t.repo.getAll().map((job) => job.relPath)).toEqual(['Acme/Spring']);
  });

  it('lists the client folders before the reconcile, so a slow or failed reconcile leaves them known', async () => {
    const t = setup();
    t.put('Acme', 'Spring', 'a.mp4');
    const folders = new ClientFolders(t.bus);
    folders.expectSeed();
    const broken = new Proxy(t.repo, {
      get: () => () => {
        throw new Error('the database is gone');
      },
    });

    await expect(t.start({ clientFolders: folders, repo: broken })).rejects.toThrow(
      'the database is gone',
    );

    expect(folders.list()).toEqual(['Acme']);
    await folders.whenSeeded(1);
  });

  it('makes the shared _Fonts folder, which is never a client and never gets a _Style', async () => {
    const t = setup();
    const folders = new ClientFolders(t.bus);

    await t.start({ clientFolders: folders });

    expect(statSync(join(t.inbox, '_Fonts')).isDirectory()).toBe(true);
    expect(readdirSync(join(t.inbox, '_Fonts'))).toEqual([]);
    expect(folders.list()).toEqual([]);
  });

  it('makes no _Graphics folder while the Graphics switch is off', async () => {
    const t = setup();
    await t.start();
    await t.start({ config: { ...configOf(t), graphics: false } });
    expect(existsSync(join(t.inbox, '_Graphics'))).toBe(false);
  });

  it('makes the _Graphics folder while the Graphics switch is on, which is never a client', async () => {
    const t = setup();
    const folders = new ClientFolders(t.bus);

    await t.start({ config: { ...configOf(t), graphics: true }, clientFolders: folders });

    expect(statSync(join(t.inbox, '_Graphics')).isDirectory()).toBe(true);
    expect(readdirSync(join(t.inbox, '_Graphics'))).toEqual([]);
    expect(folders.list()).toEqual([]);
    expect(t.repo.getAll()).toEqual([]);
  });

  it('keeps what is in _Graphics, and never makes a job of it', async () => {
    const t = setup();
    mkdirSync(join(t.inbox, '_Graphics', 'Name on a white pill', 'versions', 'v1'), {
      recursive: true,
    });
    writeFileSync(
      join(t.inbox, '_Graphics', 'Name on a white pill', 'versions', 'v1', 'index.html'),
      '<!doctype html>',
    );
    const folders = new ClientFolders(t.bus);

    await t.start({ config: { ...configOf(t), graphics: true }, clientFolders: folders });

    expect(readdirSync(join(t.inbox, '_Graphics'))).toEqual(['Name on a white pill']);
    expect(folders.list()).toEqual([]);
    expect(t.repo.getAll()).toEqual([]);
  });

  it('makes no _LUTs folder while the LUTs switch is off', async () => {
    const t = setup();
    await t.start();
    expect(existsSync(join(t.inbox, '_LUTs'))).toBe(false);
    await t.start({ config: { ...configOf(t), luts: false } });
    expect(existsSync(join(t.inbox, '_LUTs'))).toBe(false);
  });

  it('makes the _LUTs folder while the LUTs switch is on, which is never a client', async () => {
    const t = setup();
    const folders = new ClientFolders(t.bus);

    await t.start({ config: { ...configOf(t), luts: true }, clientFolders: folders });

    expect(statSync(join(t.inbox, '_LUTs')).isDirectory()).toBe(true);
    expect(readdirSync(join(t.inbox, '_LUTs'))).toEqual([]);
    expect(folders.list()).toEqual([]);
    expect(t.repo.getAll()).toEqual([]);
  });

  it('keeps what is in _LUTs, and never makes a client or a job of it', async () => {
    const t = setup();
    mkdirSync(join(t.inbox, '_LUTs', 'Sub'), { recursive: true });
    writeFileSync(join(t.inbox, '_LUTs', 'Golden Hour Warm.cube'), 'LUT_3D_SIZE 2\n');
    const folders = new ClientFolders(t.bus);

    await t.start({ config: { ...configOf(t), luts: true }, clientFolders: folders });

    expect(readdirSync(join(t.inbox, '_LUTs')).sort()).toEqual(['Golden Hour Warm.cube', 'Sub']);
    expect(folders.list()).toEqual([]);
    expect(t.repo.getAll()).toEqual([]);
  });

  it('lists no client for an inbox with no folder in it', async () => {
    const t = setup();
    const folders = new ClientFolders(t.bus);

    await t.start({ clientFolders: folders });

    expect(folders.list()).toEqual([]);
  });

  it('announces a client folder made after the first listing but before the watcher was ready', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    mkdirSync(join(t.inbox, 'Old'));
    mkdirSync(join(t.inbox, 'Gone'));
    const folders = new ClientFolders(t.bus);
    // A watcher that is slow to get ready: the disk changes while it starts.
    const slowSource: FsEventSource = {
      start: async () => {
        mkdirSync(join(t.inbox, 'Late'));
        rmSync(join(t.inbox, 'Gone'), { recursive: true });
      },
      stop: async () => {},
    };

    await t.start({ clientFolders: folders, source: slowSource });

    expect(folders.list()).toEqual(['Late', 'Old']);
    expect(t.events.filter((event) => event.type.startsWith('client.'))).toEqual([
      { type: 'client.removed', clientId: clientIdFor('Gone'), client: 'Gone' },
      { type: 'client.added', clientId: clientIdFor('Late'), client: 'Late' },
    ]);
  });

  it('keeps the list current with the real watcher: a folder made in Finder comes, one deleted goes', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    mkdirSync(join(t.inbox, 'Old'));
    const folders = new ClientFolders(t.bus);
    await t.startWatching({ clientFolders: folders });
    const clientEvents = () => t.events.filter((event) => event.type.startsWith('client.'));

    mkdirSync(join(t.inbox, 'Fresh Client'));
    await waitFor(() => folders.has('Fresh Client'), 'the new client folder to be noticed');
    expect(clientEvents()).toEqual([
      { type: 'client.added', clientId: clientIdFor('Fresh Client'), client: 'Fresh Client' },
    ]);
    // Its _Style is made by the watcher, and no job comes of it.
    await waitFor(
      () => existsSync(join(t.inbox, 'Fresh Client', '_Style')),
      'the style folder to be made',
    );

    rmSync(join(t.inbox, 'Old'), { recursive: true });
    await waitFor(() => !folders.has('Old'), 'the deleted client folder to be noticed');
    expect(clientEvents()).toContainEqual({
      type: 'client.removed',
      clientId: clientIdFor('Old'),
      client: 'Old',
    });
    expect(folders.list()).toEqual(['Fresh Client']);
    expect(t.repo.getAll()).toEqual([]);
  });

  it('starts anyway, and says so, when the client folders cannot be listed', async () => {
    const t = setup();
    mkdirSync(t.inbox, { recursive: true });
    t.put('Acme', 'Spring', 'a.mp4');
    const errors: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error: (_obj: object, msg?: string) => void errors.push(msg ?? ''),
    };
    const broken = {
      add: () => true,
      remove: () => true,
      seed: () => {
        throw new Error('no list today');
      },
      sync: () => 0,
    };

    const running = await t.start({ clientFolders: broken, logger });

    expect(running.summary.created).toBe(1);
    expect(errors).toEqual(['could not list the client folders']);
  });
});

describe('startInbox: the Generate switch', () => {
  it('keeps a reference video out of the footage of a job it finds, only while the switch is on', async () => {
    const off = setup();
    off.put('Pinewood', '97 Window Ad', 'PINEWOOD brief.txt');
    off.put('Pinewood', '97 Window Ad', 'reference/reference-video-35s.mp4');
    await off.start();
    expect(off.byName('97 Window Ad')?.inputs).toEqual({ video: 1, audio: 0, image: 0, doc: 1 });

    const on = setup();
    on.put('Pinewood', '97 Window Ad', 'PINEWOOD brief.txt');
    on.put('Pinewood', '97 Window Ad', 'reference/reference-video-35s.mp4');
    await on.start({ config: { ...configOf(on), generate: true } });
    expect(on.byName('97 Window Ad')?.inputs).toEqual({ video: 0, audio: 0, image: 0, doc: 1 });
  });
});

function configOf(t: ReturnType<typeof setup>) {
  return { inboxPath: t.inbox, exportsDir: t.exportsDir, settleMs: SETTLE_MS };
}
