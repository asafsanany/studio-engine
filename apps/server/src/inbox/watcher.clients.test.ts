import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientFolders } from '../clients/client-folders.js';
import { JobRepository } from '../db/index.js';
import { memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { DurationCache } from './probe.js';
import { clientIdFor, scanJob } from './scan.js';
import {
  createInboxWatcher,
  type FsEvent,
  type FsEventKind,
  type FsEventSource,
  type Timers,
} from './watcher.js';

// The watcher's list of client folders (CVP-159): a client is any folder directly in the inbox the
// inbox rules don't skip, with jobs or without. A real temp inbox, fake file events, and timers
// that run at once, so a debounce window is only a turn of the event loop.

class FakeSource implements FsEventSource {
  emit: (event: FsEvent) => void = () => {};
  async start(emit: (event: FsEvent) => void): Promise<void> {
    this.emit = emit;
  }
  async stop(): Promise<void> {}
}

/**
 * A timer of no delay (the debounce, set to 0 below) runs in the next microtask, so the debounce
 * passes without anyone waiting. Any other (the settle timer) never fires: these tests are about
 * client folders, not about jobs settling.
 */
const instantTimers: Timers = {
  setTimeout(callback, ms) {
    if (ms === 0) queueMicrotask(callback);
    return 0;
  },
  clearTimeout() {},
};

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-watcher-clients-'));
  cleanups.push(() => rmSync(inbox, { recursive: true, force: true }));
  const exportsDir = join(inbox, '_Exports');

  const repo = new JobRepository(memoryDb());
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const folders = new ClientFolders(bus);
  const source = new FakeSource();
  const durations = new DurationCache(async () => null);
  const watcher = createInboxWatcher({
    inboxPath: inbox,
    exportsDir,
    settleMs: 60_000,
    debounceMs: 0,
    repo,
    bus,
    timers: instantTimers,
    source,
    clients: folders,
    scan: (client, name) => scanJob(inbox, client, name, { exportsDir, durations }),
  });
  cleanups.push(() => watcher.stop());
  await watcher.start();

  const clientEvents = () => events.filter((event) => event.type.startsWith('client.'));
  return {
    inbox,
    folders,
    repo,
    events,
    clientEvents,
    mkdir: (rel: string) => mkdirSync(join(inbox, rel), { recursive: true }),
    write(rel: string, text = 'x') {
      mkdirSync(dirname(join(inbox, rel)), { recursive: true });
      writeFileSync(join(inbox, rel), text);
    },
    remove: (rel: string) => rmSync(join(inbox, rel), { recursive: true, force: true }),
    /** Reports a file event and waits until the watcher is done with it. */
    async see(kind: FsEventKind, rel: string) {
      source.emit({ kind, path: join(inbox, rel) });
      await watcher.whenIdle();
      // The sweep runs in a task the event started: give it its turns.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await watcher.whenIdle();
    },
  };
}

const added = (client: string): ServerEvent => ({
  type: 'client.added',
  clientId: clientIdFor(client),
  client,
});
const removed = (client: string): ServerEvent => ({
  type: 'client.removed',
  clientId: clientIdFor(client),
  client,
});

describe('inbox watcher: the client folders', () => {
  it('adds a client folder made in Finder, empty, and announces it', async () => {
    const t = await setup();

    t.mkdir('Empty Client');
    await t.see('addDir', 'Empty Client');

    expect(t.folders.list()).toEqual(['Empty Client']);
    expect(t.clientEvents()).toEqual([added('Empty Client')]);
  });

  it('makes no job of it: the job list stays empty, and so does the folder but for _Style', async () => {
    const t = await setup();

    t.mkdir('Empty Client');
    await t.see('addDir', 'Empty Client');
    await t.see('addDir', 'Empty Client/_Style');

    expect(t.repo.getAll()).toEqual([]);
    expect(t.events.filter((event) => event.type.startsWith('job.'))).toEqual([]);
  });

  it('adds a client folder that arrives with jobs in it, once', async () => {
    const t = await setup();

    t.write('Acme/Spring/a.mp4');
    await t.see('addDir', 'Acme');
    await t.see('addDir', 'Acme/Spring');
    await t.see('add', 'Acme/Spring/a.mp4');

    expect(t.folders.list()).toEqual(['Acme']);
    expect(t.clientEvents()).toEqual([added('Acme')]);
    expect(t.repo.getAll().map((job) => job.relPath)).toEqual(['Acme/Spring']);
  });

  it('says nothing more for the same folder seen again', async () => {
    const t = await setup();
    t.mkdir('Acme');

    await t.see('addDir', 'Acme');
    await t.see('addDir', 'Acme');
    await t.see('addDir', 'Acme/_Style');

    expect(t.clientEvents()).toEqual([added('Acme')]);
  });

  it('drops a client folder deleted in Finder, with or without jobs, and announces it', async () => {
    const t = await setup();
    t.mkdir('Empty Client');
    t.write('Acme/Spring/a.mp4');
    await t.see('addDir', 'Empty Client');
    await t.see('addDir', 'Acme');
    expect(t.folders.list()).toEqual(['Acme', 'Empty Client']);

    t.remove('Empty Client');
    await t.see('unlinkDir', 'Empty Client');
    t.remove('Acme');
    await t.see('unlinkDir', 'Acme/Spring');
    await t.see('unlinkDir', 'Acme');

    expect(t.folders.list()).toEqual([]);
    expect(t.clientEvents()).toEqual([
      added('Empty Client'),
      added('Acme'),
      removed('Empty Client'),
      removed('Acme'),
    ]);
    expect(t.repo.getAll()).toEqual([]);
  });

  it('follows a client folder renamed in Finder: one goes, the other comes', async () => {
    const t = await setup();
    t.mkdir('Old Name');
    await t.see('addDir', 'Old Name');

    t.remove('Old Name');
    t.mkdir('New Name');
    await t.see('unlinkDir', 'Old Name');
    await t.see('addDir', 'New Name');

    expect(t.folders.list()).toEqual(['New Name']);
    expect(t.clientEvents()).toEqual([added('Old Name'), removed('Old Name'), added('New Name')]);
  });

  it('does not add a folder that was gone again by the time the sweep ran', async () => {
    const t = await setup();

    t.mkdir('Blink');
    t.remove('Blink');
    await t.see('addDir', 'Blink');

    expect(t.folders.list()).toEqual([]);
    expect(t.clientEvents()).toEqual([]);
  });

  it('goes by the client id, so the folder spelled the other way is the same client', async () => {
    const t = await setup();
    const nfc = 'Café Müller'.normalize('NFC');
    t.mkdir(nfc.normalize('NFD'));

    await t.see('addDir', nfc.normalize('NFD'));
    await t.see('addDir', nfc);

    expect(t.folders.list()).toHaveLength(1);
    expect(t.folders.find(clientIdFor(nfc))).not.toBeNull();
    expect(t.clientEvents()).toHaveLength(1);
  });

  it('is not fooled by what the inbox rules skip', async () => {
    const t = await setup();
    t.mkdir('_Exports/Acme');
    t.mkdir('.hidden');
    t.write('notes.txt');

    await t.see('addDir', '_Exports');
    await t.see('addDir', '_Exports/Acme');
    await t.see('addDir', '.hidden');
    await t.see('add', 'notes.txt');

    expect(t.folders.list()).toEqual([]);
    expect(t.clientEvents()).toEqual([]);
  });

  it('does not take a loose file named like a client for one', async () => {
    const t = await setup();
    t.write('Acme', 'a file, not a folder');

    await t.see('addDir', 'Acme');

    expect(t.folders.list()).toEqual([]);
  });

  it('keeps its clients when the inbox itself goes missing (an unplugged drive)', async () => {
    const t = await setup();
    t.mkdir('Acme');
    await t.see('addDir', 'Acme');

    rmSync(t.inbox, { recursive: true, force: true });
    await t.see('unlinkDir', 'Acme');

    expect(t.folders.list()).toEqual(['Acme']);
    expect(t.clientEvents()).toEqual([added('Acme')]);
  });

  it('keeps no list when it was not given one', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'studio-watcher-clients-'));
    cleanups.push(() => rmSync(inbox, { recursive: true, force: true }));
    const source = new FakeSource();
    const bus = createEventBus();
    const events: ServerEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const watcher = createInboxWatcher({
      inboxPath: inbox,
      exportsDir: join(inbox, '_Exports'),
      settleMs: 60_000,
      debounceMs: 0,
      repo: new JobRepository(memoryDb()),
      bus,
      timers: instantTimers,
      source,
    });
    cleanups.push(() => watcher.stop());
    await watcher.start();

    mkdirSync(join(inbox, 'Acme'));
    source.emit({ kind: 'addDir', path: join(inbox, 'Acme') });
    await watcher.whenIdle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await watcher.whenIdle();

    expect(events).toEqual([]);
  });
});
