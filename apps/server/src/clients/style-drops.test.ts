import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FsEventKind, Timers } from '../inbox/watcher.js';
import { StyleDrops } from './style-drops.js';
import type { ReadPass } from './style-pass.js';

// The Finder side of the Read pass with hand-driven timers on a real temp inbox: events go in as
// the inbox watcher would pass them, and the queued passes are recorded.

const SEC = 1_000;
const SETTLE_MS = 60 * SEC;

/** Timers that fire only when the test moves time on. */
class FakeTimers implements Timers {
  now = 0;
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>();
  private next = 1;

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.scheduled.set(handle, { at: this.now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  get count(): number {
    return this.scheduled.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.scheduled]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.scheduled.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

let inbox: string;
let timers: FakeTimers;
let queued: { client: string; pass: ReadPass }[];
let drops: StyleDrops;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'studio-style-drops-'));
  timers = new FakeTimers();
  queued = [];
  drops = new StyleDrops({
    inboxPath: inbox,
    settleMs: SETTLE_MS,
    timers,
    enqueue: async (client, pass) => {
      queued.push({ client, pass });
    },
  });
});

afterEach(() => {
  drops.stop();
  rmSync(inbox, { recursive: true, force: true });
});

function drop(client: string, path: string, bytes = 10): string {
  const abs = join(inbox, client, '_Style', path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, 1));
  return abs;
}

function emit(kind: FsEventKind, client: string, path: string): void {
  drops.notify({ kind, client, path });
}

async function advance(ms: number): Promise<void> {
  timers.advance(ms);
  await drops.whenIdle();
}

describe('Finder drops into a style folder', () => {
  it('queue exactly one Read pass with the new and changed files, once the folder is quiet', async () => {
    drop('Kova Coffee', 'logo.png', 100);
    emit('add', 'Kova Coffee', 'logo.png');
    await advance(20 * SEC);
    drop('Kova Coffee', 'notes.txt', 20);
    emit('add', 'Kova Coffee', 'notes.txt');
    emit('change', 'Kova Coffee', 'notes.txt');
    drop('Kova Coffee', 'Brand/fonts/Inter-Bold.otf', 30);
    emit('add', 'Kova Coffee', 'Brand/fonts/Inter-Bold.otf');

    // 60 s after the last event, not the first.
    await advance(SETTLE_MS - 1);
    expect(queued).toEqual([]);
    await advance(1);

    expect(queued).toEqual([
      {
        client: 'Kova Coffee',
        pass: {
          kind: 'read',
          mode: 'add',
          files: [
            { name: 'logo.png', size: 100 },
            { name: 'notes.txt', size: 20 },
            { name: 'Brand/fonts/Inter-Bold.otf', size: 30 },
          ],
        },
      },
    ]);
    // Nothing more: the timer is spent.
    expect(timers.count).toBe(0);
    await advance(10 * 60 * SEC);
    expect(queued).toHaveLength(1);
  });

  it('keeps each client to itself', async () => {
    drop('Kova Coffee', 'a.png');
    drop('Arc Fitness', 'b.png');
    emit('add', 'Kova Coffee', 'a.png');
    await advance(30 * SEC);
    emit('add', 'Arc Fitness', 'b.png');

    await advance(30 * SEC);
    expect(queued.map((q) => q.client)).toEqual(['Kova Coffee']);
    await advance(30 * SEC);
    expect(queued.map((q) => [q.client, q.pass.files.map((f) => f.name)])).toEqual([
      ['Kova Coffee', ['a.png']],
      ['Arc Fitness', ['b.png']],
    ]);
  });

  it('leaves out files that were removed again before the quiet time was up', async () => {
    drop('Kova Coffee', 'a.png');
    const removed = drop('Kova Coffee', 'Old/b.png');
    emit('add', 'Kova Coffee', 'a.png');
    emit('add', 'Kova Coffee', 'Old/b.png');
    rmSync(dirname(removed), { recursive: true });
    emit('unlinkDir', 'Kova Coffee', 'Old');
    drop('Kova Coffee', 'c.png');
    emit('add', 'Kova Coffee', 'c.png');
    rmSync(join(inbox, 'Kova Coffee', '_Style', 'c.png'));
    // The unlink event got lost: the file is checked when the timer fires.

    await advance(SETTLE_MS);
    expect(queued.map((q) => q.pass.files.map((f) => f.name))).toEqual([['a.png']]);
  });

  it('queues nothing when every dropped file is gone, or only removals happened', async () => {
    emit('unlink', 'Kova Coffee', 'old.png');
    expect(timers.count).toBe(0);
    emit('add', 'Kova Coffee', 'never-there.png');
    await advance(SETTLE_MS);
    expect(queued).toEqual([]);
  });

  it('does not read again what the upload route put there', async () => {
    const path = drop('Kova Coffee', 'logo (1).png', 40);
    const info = statSync(path);
    drops.expectUpload('Kova Coffee', 'logo (1).png', { size: info.size, mtimeMs: info.mtimeMs });
    emit('add', 'Kova Coffee', 'logo (1).png');
    drop('Kova Coffee', 'notes.txt', 5);
    emit('add', 'Kova Coffee', 'notes.txt');

    await advance(SETTLE_MS);
    expect(queued.map((q) => q.pass.files)).toEqual([[{ name: 'notes.txt', size: 5 }]]);
  });

  it('does read an uploaded file that was changed afterwards in Finder', async () => {
    const path = drop('Kova Coffee', 'logo.png', 40);
    const info = statSync(path);
    drops.expectUpload('Kova Coffee', 'logo.png', { size: info.size, mtimeMs: info.mtimeMs });
    emit('add', 'Kova Coffee', 'logo.png');
    await advance(SETTLE_MS);
    expect(queued).toEqual([]);

    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    emit('change', 'Kova Coffee', 'logo.png');
    await advance(SETTLE_MS);
    expect(queued.map((q) => q.pass.files)).toEqual([[{ name: 'logo.png', size: 40 }]]);
  });

  it('forgets everything waiting once stopped', async () => {
    drop('Kova Coffee', 'a.png');
    emit('add', 'Kova Coffee', 'a.png');
    drops.stop();
    expect(timers.count).toBe(0);
    emit('add', 'Kova Coffee', 'a.png');
    await advance(SETTLE_MS);
    expect(queued).toEqual([]);
  });
});
