import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Job, ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { StyleDrops } from '../clients/style-drops.js';
import type { ReadPass } from '../clients/style-pass.js';
import { moveIntoStyle } from '../clients/style-upload.js';
import { JobRepository } from '../db/index.js';
import { idFor, memoryDb } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { DurationCache } from './probe.js';
import { scanJob } from './scan.js';
import { createInboxWatcher, type InboxWatcher, type StyleFsEvent } from './watcher.js';

// One integration test group against the real file system and the real chokidar. Real time is
// used here, so the numbers are small but generous, and every wait is a poll with a deadline:
// a slow machine makes the tests slower, not flaky. Fake-timer coverage of the same logic is in
// watcher.test.ts.

const SETTLE_MS = 1_500;
const DEBOUNCE_MS = 50;

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

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startWatcher(
  options: {
    onFolderRemovedWhileEditing?: (job: Job) => void;
    onStyleEvent?: (event: StyleFsEvent) => void;
  } = {},
) {
  // Straight from tmpdir(): on macOS that sits behind the /var -> /private/var link, which a
  // linked inbox folder (Dropbox, an external drive) does in real life too.
  const base = mkdtempSync(join(tmpdir(), 'studio-watcher-real-'));
  const inbox = join(base, 'Studio Inbox');
  const outside = join(base, 'elsewhere');
  mkdirSync(inbox);
  mkdirSync(outside);
  const exportsDir = join(inbox, '_Exports');
  mkdirSync(exportsDir);

  const repo = new JobRepository(memoryDb());
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const durations = new DurationCache(async () => null);

  const watcher: InboxWatcher = createInboxWatcher({
    inboxPath: inbox,
    exportsDir,
    settleMs: SETTLE_MS,
    debounceMs: DEBOUNCE_MS,
    repo,
    bus,
    scan: (client, name) => scanJob(inbox, client, name, { exportsDir, durations }),
    onFolderRemovedWhileEditing: options.onFolderRemovedWhileEditing,
    onStyleEvent: options.onStyleEvent,
  });
  cleanups.push(async () => {
    await watcher.stop();
    rmSync(base, { recursive: true, force: true });
  });
  await watcher.start();

  return {
    inbox,
    outside,
    repo,
    events,
    watcher,
    write(rel: string, bytes = 1) {
      const path = join(inbox, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.alloc(bytes, 1));
    },
    job(relPath: string): Job | null {
      return repo.get(idFor(relPath));
    },
  };
}

describe('inbox watcher on the real file system', () => {
  it('keeps a job arriving while files are copied in, queues it after the quiet time, and ignores edit/ and _Exports/', async () => {
    const h = await startWatcher();
    const rel = 'Acme/Spring';

    // Files land every 150 ms. From the first one the job exists and is arriving, always.
    h.write(`${rel}/clip0.mp4`, 100);
    for (let i = 1; i <= 6; i += 1) {
      await sleep(150);
      h.write(`${rel}/clip${i}.mp4`, 100 * (i + 1));
      const job = await waitFor(() => h.job(rel), 'the job to appear');
      expect(job.state).toBe('arriving');
    }

    // The last file is in; wait for the rescan to count all seven.
    await waitFor(() => h.job(rel)?.inputs.video === 7, 'seven clips to be counted');
    expect(h.job(rel)?.state).toBe('arriving');

    // Queued once the folder has been quiet for SETTLE_MS since the last change.
    const queued = await waitFor(
      () => (h.job(rel)?.state === 'queued' ? h.job(rel) : null),
      'the job to be queued',
    );
    expect(queued.sizeBytes).toBe(100 * (1 + 2 + 3 + 4 + 5 + 6 + 7));
    expect(
      Date.parse(queued.settledAt ?? '') - Date.parse(queued.lastChangeAt),
    ).toBeGreaterThanOrEqual(SETTLE_MS);
    expect(h.events.at(-1)).toEqual({ type: 'job.upsert', job: queued });

    // Writes the engine itself makes, and other things it must not see, change nothing.
    const eventsBefore = h.events.length;
    h.write(`${rel}/edit/transcripts/clip0.json`, 50);
    h.write(`${rel}/edit/final.mp4`, 5_000);
    h.write(`${rel}/.DS_Store`, 10);
    h.write(`${rel}/clip7.mp4.crdownload`, 10);
    h.write('_Exports/Acme/Spring.mp4', 5_000);
    h.write('Acme/brief.pdf', 10);
    h.write('notes.txt', 10);
    await sleep(DEBOUNCE_MS * 6 + 300);
    expect(h.job(rel)).toEqual(queued);
    expect(h.events.length).toBe(eventsBefore);
    expect(h.repo.getAll()).toHaveLength(1);

    // The watcher is alive, though: a real file takes the job back to arriving...
    h.write(`${rel}/clip7.mp4`, 70);
    const again = await waitFor(
      () => (h.job(rel)?.state === 'arriving' ? h.job(rel) : null),
      'the job to arrive again',
    );
    expect(again.inputs.video).toBe(8);
    // ...and then to queued again.
    await waitFor(() => h.job(rel)?.state === 'queued', 'the job to be queued again');
  }, 30_000);

  it('removes a job whose folder is deleted, and fails one that is being edited', async () => {
    const removed: Job[] = [];
    const h = await startWatcher({ onFolderRemovedWhileEditing: (job) => removed.push(job) });

    h.write('Acme/Gone/a.mp4', 10);
    h.write('Acme/Editing/a.mp4', 10);
    h.write('Acme/Kept/a.mp4', 10);
    await waitFor(() => h.repo.getAll().length === 3, 'three jobs');
    await waitFor(
      () => h.repo.getAll().every((job) => job.state === 'queued'),
      'all three to be queued',
    );

    const editing = h.job('Acme/Editing') as Job;
    h.repo.applyTransition(editing.id, { type: 'START' });
    h.repo.applyTransition(editing.id, { type: 'PROGRESS', step: 5, sub: null });

    rmSync(join(h.inbox, 'Acme', 'Gone'), { recursive: true });
    rmSync(join(h.inbox, 'Acme', 'Editing'), { recursive: true });

    await waitFor(() => h.job('Acme/Gone') === null, 'the deleted job to be removed');
    const failed = await waitFor(
      () => (h.job('Acme/Editing')?.state === 'failed' ? h.job('Acme/Editing') : null),
      'the edited job to fail',
    );
    expect(failed).toMatchObject({ step: 5, failedAt: 5, error: 'Folder was removed' });
    expect(removed).toEqual([failed]);
    expect(h.events).toContainEqual({ type: 'job.remove', id: idFor('Acme/Gone') });
    expect(h.job('Acme/Kept')?.state).toBe('queued');
  }, 30_000);

  it('finds job and client folders that are moved in whole, Hebrew names included', async () => {
    const h = await startWatcher();

    // Built outside the inbox and moved in, the way Finder does for a folder on the same disk.
    const hebrew = 'לקוח';
    mkdirSync(join(h.outside, 'Newco', 'Pilot'), { recursive: true });
    writeFileSync(join(h.outside, 'Newco', 'Pilot', 'a.mp4'), Buffer.alloc(10));
    writeFileSync(join(h.outside, 'Newco', 'Pilot', 'b.mov'), Buffer.alloc(20));
    mkdirSync(join(h.outside, hebrew, 'סרטון'), { recursive: true });
    writeFileSync(join(h.outside, hebrew, 'סרטון', 'a.mp4'), Buffer.alloc(30));
    mkdirSync(join(h.outside, 'Moved'), { recursive: true });
    writeFileSync(join(h.outside, 'Moved', 'a.mp4'), Buffer.alloc(5));
    mkdirSync(join(h.inbox, 'Acme'));

    renameSync(join(h.outside, 'Newco'), join(h.inbox, 'Newco'));
    renameSync(join(h.outside, hebrew), join(h.inbox, hebrew));
    renameSync(join(h.outside, 'Moved'), join(h.inbox, 'Acme', 'Moved'));

    const pilot = await waitFor(() => h.job('Newco/Pilot'), 'the moved-in client to show up');
    expect(pilot).toMatchObject({ state: 'arriving', sizeBytes: 30 });
    expect(pilot.inputs.video).toBe(2);
    const hebrewJob = await waitFor(() => h.job(`${hebrew}/סרטון`), 'the Hebrew job to show up');
    expect(hebrewJob).toMatchObject({ client: hebrew, name: 'סרטון', sizeBytes: 30 });
    const moved = await waitFor(() => h.job('Acme/Moved'), 'the moved-in job to show up');
    expect(moved.sizeBytes).toBe(5);

    // Moved out again, the job goes.
    renameSync(join(h.inbox, 'Acme', 'Moved'), join(h.outside, 'Moved-back'));
    await waitFor(() => h.job('Acme/Moved') === null, 'the moved-out job to be removed');
    expect(h.repo.getAll()).toHaveLength(2);
  }, 30_000);

  it('makes the _Style folder of a client that appears, and nothing in it is taken for a job or a change', async () => {
    const h = await startWatcher();

    // A new client folder appears with a job in it (Finder copies the folder first).
    h.write('Newco/Pilot/a.mp4', 10);
    await waitFor(() => h.job('Newco/Pilot'), 'the new client to show up');
    await waitFor(() => existsSync(join(h.inbox, 'Newco', '_Style')), 'the _Style folder');

    // Nothing in _Style is a job, or changes one, or is even looked at. (First let the rescans of
    // the files that made the client folder finish, so that only _Style is left to cause events.)
    await sleep(DEBOUNCE_MS * 6 + 300);
    const eventsBefore = h.events.length;
    h.write('Newco/_Style/style.md', 20);
    h.write('Newco/_Style/kit/slot_1/index.html', 20);
    h.write('Newco/_Style/reference.mp4', 5_000);
    await sleep(DEBOUNCE_MS * 6 + 300);

    expect(h.repo.getAll().map((job) => job.relPath)).toEqual(['Newco/Pilot']);
    expect(h.job('Newco/Pilot')).toMatchObject({ state: 'arriving', sizeBytes: 10 });
    expect(h.events.length).toBe(eventsBefore);
  }, 30_000);

  it('turns files dropped into _Style into one Read pass once it is quiet, never style.md or kit/ or an upload', async () => {
    const queued: { client: string; pass: ReadPass }[] = [];
    let drops: StyleDrops | undefined;
    const h = await startWatcher({ onStyleEvent: (event) => drops?.notify(event) });
    drops = new StyleDrops({
      inboxPath: h.inbox,
      settleMs: SETTLE_MS,
      enqueue: async (client, pass) => {
        queued.push({ client, pass });
      },
    });
    cleanups.push(() => drops?.stop());
    mkdirSync(join(h.inbox, 'Kova', '_Style'), { recursive: true });
    await sleep(DEBOUNCE_MS * 6 + 300);

    // The owner drops two files (one in a folder) in Finder; the engine writes its own files meanwhile.
    h.write('Kova/_Style/logo.png', 300);
    h.write('Kova/_Style/Brand/notes.txt', 40);
    h.write('Kova/_Style/style.md', 20);
    h.write('Kova/_Style/style.md.new', 20);
    h.write('Kova/_Style/kit/slot_1/index.html', 20);
    h.write('Kova/_Style/.DS_Store', 20);
    // The upload route stages in a dot-folder and moves its file in, announcing it.
    h.write('Kova/_Style/.upload-1/0', 70);
    await moveIntoStyle(
      [{ name: 'deck.pdf', path: join(h.inbox, 'Kova/_Style/.upload-1/0'), size: 70 }],
      join(h.inbox, 'Kova', '_Style'),
      (name, stat) => drops?.expectUpload('Kova', name, stat),
    );

    const first = await waitFor(() => queued[0], 'the Read pass');
    expect(first.client).toBe('Kova');
    expect(first.pass.kind).toBe('read');
    expect(first.pass.mode).toBe('add');
    expect([...first.pass.files].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'Brand/notes.txt', size: 40 },
      { name: 'logo.png', size: 300 },
    ]);

    // style.md being rewritten later (the engine installing a style) queues nothing.
    h.write('Kova/_Style/style.md', 30);
    await sleep(SETTLE_MS + 500);
    expect(queued).toHaveLength(1);
    // Nothing in _Style was ever taken for a job.
    expect(h.repo.getAll()).toEqual([]);
  }, 30_000);

  it('fails to start, saying why, when the inbox folder does not exist', async () => {
    const base = mkdtempSync(join(tmpdir(), 'studio-watcher-real-'));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const missing = join(base, 'No Such Inbox');
    const watcher = createInboxWatcher({
      inboxPath: missing,
      exportsDir: join(missing, '_Exports'),
      settleMs: SETTLE_MS,
      repo: new JobRepository(memoryDb()),
      bus: createEventBus(),
    });
    await expect(watcher.start()).rejects.toThrow(/inbox folder does not exist.*No Such Inbox/);
    await watcher.stop();
  });

  it('stop closes the watcher: later changes are not seen', async () => {
    const h = await startWatcher();
    h.write('Acme/Spring/a.mp4', 10);
    await waitFor(() => h.job('Acme/Spring'), 'the job to appear');

    await h.watcher.stop();
    h.write('Acme/Other/a.mp4', 10);
    await sleep(DEBOUNCE_MS * 6 + 300);

    expect(h.job('Acme/Other')).toBeNull();
    expect(h.job('Acme/Spring')?.state).toBe('arriving');
    await sleep(SETTLE_MS + 200);
    // The settle timer was dropped with the watcher.
    expect(h.job('Acme/Spring')?.state).toBe('arriving');
  }, 30_000);
});
