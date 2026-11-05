import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eventForAction, type Job, type ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobRepository } from '../db/index.js';
import { type FakeClock, fakeClock, idFor, makeScan, memoryDb, T0 } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { useClientRegistry } from './client-registry.js';
import { DurationCache } from './probe.js';
import { type ScannedJob, scanJob } from './scan.js';
import {
  createInboxWatcher,
  createPathRules,
  FOLDER_REMOVED_ERROR,
  type FsEvent,
  type FsEventKind,
  type FsEventSource,
  isIgnoredInStyle,
  isIgnoredSegments,
  isWatchedStyleSegments,
  locateEvent,
  locateStyleEvent,
  type StyleFsEvent,
  type Timers,
  type WatcherLogger,
} from './watcher.js';

// --- the path rules ----------------------------------------------------------------------------

describe('locateEvent: unregistered clients', () => {
  it('ignores everything under a folder that is not a registered client', () => {
    useClientRegistry({ has: (name) => name === 'Acme' });
    try {
      const rules = createPathRules('/inbox', '/inbox/_Exports');
      const at = (kind: FsEventKind, rel: string): FsEvent => ({ kind, path: `/inbox/${rel}` });
      expect(locateEvent(rules, at('addDir', 'edit'))).toBeNull();
      expect(locateEvent(rules, at('addDir', 'edit/verify'))).toBeNull();
      expect(locateEvent(rules, at('add', 'edit/verify/a.mp4'))).toBeNull();
      expect(locateEvent(rules, at('addDir', 'Acme/Spring'))).toEqual({
        client: 'Acme',
        name: 'Spring',
      });
    } finally {
      useClientRegistry(null);
    }
  });
});

describe('locateEvent', () => {
  const inbox = '/data/Studio Inbox';
  const rules = createPathRules(inbox, `${inbox}/_Exports`);
  const at = (kind: FsEventKind, rel: string): FsEvent => ({ kind, path: `${inbox}/${rel}` });

  it('maps any change inside Client/Job/ to that job', () => {
    const job = { client: 'Acme', name: 'Spring' };
    expect(locateEvent(rules, at('add', 'Acme/Spring/a.mp4'))).toEqual(job);
    expect(locateEvent(rules, at('change', 'Acme/Spring/raw/day2/b.wav'))).toEqual(job);
    expect(locateEvent(rules, at('unlink', 'Acme/Spring/a.mp4'))).toEqual(job);
    expect(locateEvent(rules, at('addDir', 'Acme/Spring/raw'))).toEqual(job);
    expect(locateEvent(rules, at('unlinkDir', 'Acme/Spring/raw'))).toEqual(job);
  });

  it('treats a folder at Client/Job level as the job itself, empty or not', () => {
    expect(locateEvent(rules, at('addDir', 'Acme/Spring'))).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
    expect(locateEvent(rules, at('unlinkDir', 'Acme/Spring'))).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
  });

  it('maps a client folder appearing or vanishing to the client', () => {
    expect(locateEvent(rules, at('addDir', 'Acme'))).toEqual({ client: 'Acme' });
    expect(locateEvent(rules, at('unlinkDir', 'Acme'))).toEqual({ client: 'Acme' });
  });

  it('ignores loose files in the inbox and in a client folder, and the inbox itself', () => {
    expect(locateEvent(rules, at('add', 'notes.txt'))).toBeNull();
    expect(locateEvent(rules, at('change', 'Acme/brief.pdf'))).toBeNull();
    expect(locateEvent(rules, at('unlink', 'Acme/brief.pdf'))).toBeNull();
    expect(locateEvent(rules, { kind: 'addDir', path: inbox })).toBeNull();
  });

  it('ignores paths outside the inbox', () => {
    expect(
      locateEvent(rules, { kind: 'add', path: '/data/Elsewhere/Acme/Spring/a.mp4' }),
    ).toBeNull();
    expect(
      locateEvent(rules, { kind: 'add', path: '/data/Studio Inbox 2/Acme/Spring/a.mp4' }),
    ).toBeNull();
  });

  it('ignores the edit/ workspace at the job root, whatever its case, but not an edit/ deeper down', () => {
    expect(locateEvent(rules, at('add', 'Acme/Spring/edit/transcripts/a.json'))).toBeNull();
    expect(locateEvent(rules, at('addDir', 'Acme/Spring/edit'))).toBeNull();
    expect(locateEvent(rules, at('change', 'Acme/Spring/Edit/final.mp4'))).toBeNull();
    // The scanner counts files in Raw/edit/, so changes there matter.
    expect(locateEvent(rules, at('add', 'Acme/Spring/Raw/edit/b.mp4'))).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
  });

  it('ignores _Exports, whatever its case', () => {
    expect(locateEvent(rules, at('add', '_Exports/Acme/Spring.mp4'))).toBeNull();
    expect(locateEvent(rules, at('addDir', '_Exports/Acme'))).toBeNull();
    expect(locateEvent(rules, at('addDir', '_Exports'))).toBeNull();
    expect(locateEvent(rules, at('add', '_exports/Acme/Spring.mp4'))).toBeNull();
  });

  it('ignores the shared _Fonts folder, whatever its case: it is never a client', () => {
    expect(locateEvent(rules, at('add', '_Fonts/Heebo-Bold.ttf'))).toBeNull();
    expect(locateEvent(rules, at('add', '_Fonts/Rubik/Rubik-Bold.ttf'))).toBeNull();
    expect(locateEvent(rules, at('addDir', '_Fonts/Rubik'))).toBeNull();
    expect(locateEvent(rules, at('addDir', '_Fonts'))).toBeNull();
    expect(locateEvent(rules, at('add', '_fonts/Job/clip.mp4'))).toBeNull();
    expect(locateStyleEvent(rules, at('add', '_Fonts/_Style/logo.png'))).toBeNull();
  });

  it('ignores the Graphics library _Graphics, whatever its case: it is never a client', () => {
    expect(locateEvent(rules, at('addDir', '_Graphics'))).toBeNull();
    expect(locateEvent(rules, at('addDir', '_Graphics/Name on a white pill'))).toBeNull();
    expect(
      locateEvent(rules, at('add', '_Graphics/Name on a white pill/work/compositions/lib.html')),
    ).toBeNull();
    expect(locateEvent(rules, at('add', '_graphics/Job/clip.mp4'))).toBeNull();
    expect(locateStyleEvent(rules, at('add', '_Graphics/_Style/logo.png'))).toBeNull();
    // A client's own folder called Graphics is still a client.
    expect(locateEvent(rules, at('addDir', 'Graphics/Job'))).not.toBeNull();
  });

  it('ignores the LUTs library _LUTs, whatever its case: it is never a client', () => {
    expect(locateEvent(rules, at('addDir', '_LUTs'))).toBeNull();
    expect(locateEvent(rules, at('add', '_LUTs/Golden Hour Warm.cube'))).toBeNull();
    expect(locateEvent(rules, at('addDir', '_LUTs/Sub'))).toBeNull();
    expect(locateEvent(rules, at('add', '_luts/Job/clip.mp4'))).toBeNull();
    expect(locateStyleEvent(rules, at('add', '_LUTs/_Style/logo.png'))).toBeNull();
    // A client's own folder called LUTs is still a client.
    expect(locateEvent(rules, at('addDir', 'LUTs/Job'))).not.toBeNull();
  });

  it('ignores dotfiles and dot-folders at every level', () => {
    expect(locateEvent(rules, at('add', '.DS_Store'))).toBeNull();
    expect(locateEvent(rules, at('addDir', '.Trashes'))).toBeNull();
    expect(locateEvent(rules, at('add', '.hidden/Spring/a.mp4'))).toBeNull();
    expect(locateEvent(rules, at('addDir', 'Acme/.hidden'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/Spring/.DS_Store'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/Spring/raw/._a.mp4'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/Spring/.git/HEAD'))).toBeNull();
  });

  it('ignores partial downloads inside a job', () => {
    expect(locateEvent(rules, at('add', 'Acme/Spring/a.mp4.crdownload'))).toBeNull();
    expect(locateEvent(rules, at('change', 'Acme/Spring/raw/b.mov.part'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/Spring/c.mp4.download/data'))).toBeNull();
    // ...and notices the finished file when it is renamed to its real name.
    expect(locateEvent(rules, at('add', 'Acme/Spring/a.mp4'))).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
  });

  it('skips the configured exports folder when it is not called _Exports', () => {
    const custom = createPathRules(inbox, `${inbox}/Finished`);
    expect(
      locateEvent(custom, { kind: 'add', path: `${inbox}/Finished/Acme/Spring.mp4` }),
    ).toBeNull();
    // A folder of that name deeper down is an ordinary folder.
    expect(
      locateEvent(custom, { kind: 'add', path: `${inbox}/Acme/Spring/Finished/a.mp4` }),
    ).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
  });

  it('skips an exports folder nested below the inbox, wherever the job reaches it', () => {
    const nested = createPathRules(inbox, `${inbox}/Acme/Spring/out`);
    expect(locateEvent(nested, { kind: 'add', path: `${inbox}/Acme/Spring/out/x.mp4` })).toBeNull();
    expect(locateEvent(nested, { kind: 'add', path: `${inbox}/Acme/Spring/in/x.mp4` })).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
  });

  it('does not skip anything for an exports folder outside the inbox', () => {
    const outside = createPathRules(inbox, '/data/Exports');
    expect(outside.exportsSegments).toBeNull();
    expect(
      locateEvent(outside, { kind: 'add', path: `${inbox}/Acme/Spring/a.mp4` }),
    ).not.toBeNull();
  });

  it('compares the exports folder in Unicode NFC, so a decomposed spelling still matches', () => {
    const accented = createPathRules(inbox, `${inbox}/Livrés`);
    expect(isIgnoredSegments(accented, ['Livrés', 'Acme', 'Spring.mp4'])).toBe(true);
    expect(isIgnoredSegments(accented, ['Livres', 'Acme', 'Spring.mp4'])).toBe(false);
  });

  it("ignores a client's _Style folder and everything in it, whatever its case", () => {
    expect(locateEvent(rules, at('addDir', 'Acme/_Style'))).toBeNull();
    expect(locateEvent(rules, at('unlinkDir', 'Acme/_Style'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/_Style/style.md'))).toBeNull();
    expect(locateEvent(rules, at('change', 'Acme/_Style/kit/slot_1/index.html'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/_style/logo.png'))).toBeNull();
    expect(locateEvent(rules, at('addDir', 'Acme/_STYLE'))).toBeNull();
    expect(isIgnoredSegments(rules, ['Acme', '_Style'])).toBe(true);
    expect(isIgnoredSegments(rules, ['Acme', '_Style', 'kit', 'a.png'])).toBe(true);
  });

  it("ignores a client's _Series folder and everything in it, whatever its case", () => {
    expect(locateEvent(rules, at('addDir', 'Acme/_Series'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/_Series/Weekly/series.md'))).toBeNull();
    expect(locateEvent(rules, at('change', 'Acme/_series/Weekly/kit/index.html'))).toBeNull();
    expect(isIgnoredSegments(rules, ['Acme', '_SERIES', 'Weekly'])).toBe(true);
    expect(locateEvent(rules, at('add', 'Acme/Spring/_Series/a.mp4'))).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
  });

  it("ignores a client's _Shared folder and everything in it, whatever its case", () => {
    expect(locateEvent(rules, at('addDir', 'Acme/_Shared'))).toBeNull();
    expect(locateEvent(rules, at('add', 'Acme/_Shared/broll/beach.mp4'))).toBeNull();
    expect(locateEvent(rules, at('change', 'Acme/_shared/logo.png'))).toBeNull();
    expect(isIgnoredSegments(rules, ['Acme', '_SHARED'])).toBe(true);
  });

  it('only reserves _Style at job level: deeper down, and as a client, it is an ordinary folder', () => {
    expect(locateEvent(rules, at('add', 'Acme/Spring/_Style/a.mp4'))).toEqual({
      client: 'Acme',
      name: 'Spring',
    });
    expect(locateEvent(rules, at('addDir', '_Style'))).toEqual({ client: '_Style' });
  });

  it('follows the scanner for names at client and job level: only dot-names are skipped there', () => {
    // A folder called Foo.part is a job to the scanner, so its events must reach the watcher.
    expect(locateEvent(rules, at('addDir', 'Acme/Foo.part'))).toEqual({
      client: 'Acme',
      name: 'Foo.part',
    });
    expect(locateEvent(rules, at('add', 'Acme/Foo.part/a.mp4'))).toEqual({
      client: 'Acme',
      name: 'Foo.part',
    });
    // _Exports is only reserved at client level.
    expect(locateEvent(rules, at('addDir', 'Acme/_Exports'))).toEqual({
      client: 'Acme',
      name: '_Exports',
    });
  });
});

describe('locateStyleEvent', () => {
  const inbox = '/data/Studio Inbox';
  const rules = createPathRules(inbox, `${inbox}/_Exports`);
  const at = (kind: FsEventKind, rel: string): FsEvent => ({ kind, path: `${inbox}/${rel}` });

  it('maps a file in a client’s _Style folder, at any depth, to that client and its path there', () => {
    expect(locateStyleEvent(rules, at('add', 'Kova/_Style/logo.png'))).toEqual({
      kind: 'add',
      client: 'Kova',
      path: 'logo.png',
    });
    expect(locateStyleEvent(rules, at('change', 'Kova/_style/Brand/fonts/Inter.otf'))).toEqual({
      kind: 'change',
      client: 'Kova',
      path: 'Brand/fonts/Inter.otf',
    });
    expect(locateStyleEvent(rules, at('unlinkDir', 'Kova/_Style/Brand'))).toEqual({
      kind: 'unlinkDir',
      client: 'Kova',
      path: 'Brand',
    });
  });

  it('ignores style.md, style.md.new, kit/, dotfiles, partial downloads and folders appearing', () => {
    for (const rel of [
      'Kova/_Style/style.md',
      'Kova/_Style/Style.MD',
      'Kova/_Style/style.md.new',
      'Kova/_Style/kit/slot_1/index.html',
      'Kova/_Style/Kit/a.png',
      'Kova/_Style/.DS_Store',
      'Kova/_Style/.upload-1234/0',
      'Kova/_Style/.style.md.new.tmp',
      'Kova/_Style/.fail-style',
      'Kova/_Style/Brand/._logo.png',
      'Kova/_Style/ref.mov.crdownload',
    ]) {
      expect(locateStyleEvent(rules, at('add', rel)), rel).toBeNull();
    }
    expect(locateStyleEvent(rules, at('addDir', 'Kova/_Style/Brand'))).toBeNull();
    expect(locateStyleEvent(rules, at('addDir', 'Kova/_Style'))).toBeNull();
    expect(locateStyleEvent(rules, at('unlinkDir', 'Kova/_Style'))).toBeNull();
    // A style.md deeper down is an ordinary file.
    expect(locateStyleEvent(rules, at('add', 'Kova/_Style/Old/style.md'))?.path).toBe(
      'Old/style.md',
    );
  });

  it('is nothing for jobs, loose files, _Style deeper in a job, _Exports or a dot-folder client', () => {
    expect(locateStyleEvent(rules, at('add', 'Kova/Spring/a.mp4'))).toBeNull();
    expect(locateStyleEvent(rules, at('add', 'Kova/logo.png'))).toBeNull();
    expect(locateStyleEvent(rules, at('add', 'Kova/Spring/_Style/a.png'))).toBeNull();
    expect(locateStyleEvent(rules, at('add', '_Exports/_Style/a.png'))).toBeNull();
    expect(locateStyleEvent(rules, at('add', '.hidden/_Style/a.png'))).toBeNull();
    expect(
      locateStyleEvent(rules, { kind: 'add', path: '/elsewhere/Kova/_Style/a.png' }),
    ).toBeNull();
  });

  it('takes a change inside a macOS package for a change of the package', () => {
    expect(locateStyleEvent(rules, at('add', 'Kova/_Style/Brand.pages/Data/preview.jpg'))).toEqual({
      kind: 'change',
      client: 'Kova',
      path: 'Brand.pages',
    });
  });

  it('lets chokidar into _Style for these files only', () => {
    expect(isWatchedStyleSegments(rules, ['Kova', '_Style'])).toBe(true);
    expect(isWatchedStyleSegments(rules, ['Kova', '_Style', 'Brand', 'a.png'])).toBe(true);
    expect(isWatchedStyleSegments(rules, ['Kova', '_Style', 'kit'])).toBe(false);
    expect(isWatchedStyleSegments(rules, ['Kova', 'Spring'])).toBe(false);
    expect(isIgnoredInStyle([])).toBe(false);
    expect(isIgnoredInStyle(['style.md'])).toBe(true);
  });
});

// --- test kit ----------------------------------------------------------------------------------

/** Timers driven by hand, on the same clock as the repository. */
class FakeTimers implements Timers {
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>();
  private next = 1;

  constructor(private readonly clock: FakeClock) {}

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.next++;
    this.scheduled.set(handle, { at: this.clock().getTime() + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  get count(): number {
    return this.scheduled.size;
  }

  /** Takes the earliest timer due at or before `limit` off the list, or undefined. */
  take(limit: number): { at: number; callback: () => void } | undefined {
    let best: [number, { at: number; callback: () => void }] | undefined;
    for (const entry of this.scheduled) {
      if (entry[1].at <= limit && (best === undefined || entry[1].at < best[1].at)) best = entry;
    }
    if (best === undefined) return undefined;
    this.scheduled.delete(best[0]);
    return best[1];
  }
}

class FakeSource implements FsEventSource {
  emit: (event: FsEvent) => void = () => {};
  started = 0;
  stopped = 0;
  failStart: Error | undefined;

  async start(emit: (event: FsEvent) => void): Promise<void> {
    if (this.failStart) throw this.failStart;
    this.started += 1;
    this.emit = emit;
  }

  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

function recordingLogger() {
  const lines: { level: string; msg: string | undefined; obj: object }[] = [];
  const log =
    (level: string) =>
    (obj: object, msg?: string): void => {
      lines.push({ level, msg, obj });
    };
  const logger: WatcherLogger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  return { logger, lines };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface HarnessOptions {
  settleMs?: number;
  debounceMs?: number;
  /** Replaces the scan; `real` is the scan it replaces. */
  scan?: (
    client: string,
    name: string,
    real: () => Promise<ScannedJob | null>,
  ) => Promise<ScannedJob | null>;
  exportsName?: string;
  /** The Generate switch, for the scan (`ScanOptions.generate`). */
  generate?: boolean;
  onFolderRemovedWhileEditing?: (job: Job) => void;
  onStyleEvent?: (event: StyleFsEvent) => void;
  /** The series name rule; it gets the repository, so it can write what it decides. */
  assignSeries?: (job: Job, repo: JobRepository) => Job;
}

/**
 * A watcher on a real temp folder with a fake clock, fake timers and a fake event source. Files
 * are really written, so the scanner really reads them; only time and the events are faked.
 */
function createHarness(options: HarnessOptions = {}) {
  const inbox = mkdtempSync(join(tmpdir(), 'studio-watcher-'));
  cleanups.push(() => rmSync(inbox, { recursive: true, force: true }));
  const exportsDir = join(inbox, options.exportsName ?? '_Exports');

  const clock = fakeClock();
  const timers = new FakeTimers(clock);
  const repo = new JobRepository(memoryDb(), { clock });
  const bus = createEventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const source = new FakeSource();
  const { logger, lines } = recordingLogger();
  const scanCalls: string[] = [];
  const durations = new DurationCache(async () => null);

  const watcher = createInboxWatcher({
    inboxPath: inbox,
    exportsDir,
    settleMs: options.settleMs ?? 60_000,
    debounceMs: options.debounceMs ?? 500,
    repo,
    bus,
    clock,
    timers,
    source,
    logger,
    scan: async (client, name) => {
      scanCalls.push(`${client}/${name}`);
      const real = () =>
        scanJob(inbox, client, name, { exportsDir, durations, generate: options.generate });
      return options.scan ? options.scan(client, name, real) : real();
    },
    onFolderRemovedWhileEditing: options.onFolderRemovedWhileEditing,
    onStyleEvent: options.onStyleEvent,
    assignSeries: options.assignSeries && ((job) => options.assignSeries?.(job, repo) ?? job),
  });
  cleanups.push(() => {
    void watcher.stop();
  });

  const now = () => clock().getTime();

  return {
    inbox,
    exportsDir,
    clock,
    timers,
    repo,
    bus,
    events,
    source,
    watcher,
    lines,
    scanCalls,
    now,
    /** Writes a file (folders as needed) with this many bytes. Paths are relative to the inbox. */
    write(rel: string, bytes = 1) {
      const path = join(inbox, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.alloc(bytes, 1));
    },
    mkdir(rel: string) {
      mkdirSync(join(inbox, rel), { recursive: true });
    },
    remove(rel: string) {
      rmSync(join(inbox, rel), { recursive: true, force: true });
    },
    /** Reports a file event, as the event source would. */
    emit(kind: FsEventKind, rel: string) {
      source.emit({ kind, path: join(inbox, rel) });
    },
    /** Moves time forward, firing every timer that comes due and letting its rescan finish. */
    async advance(ms: number) {
      const target = now() + ms;
      for (;;) {
        const due = timers.take(target);
        if (due === undefined) break;
        if (due.at > now()) clock.tick(due.at - now());
        due.callback();
        await watcher.whenIdle();
      }
      if (target > now()) clock.tick(target - now());
    },
    job(relPath: string): Job | null {
      return repo.get(idFor(relPath));
    },
    /** The state of the job, or 'none'. */
    state(relPath: string): string {
      return repo.get(idFor(relPath))?.state ?? 'none';
    },
    upserts(): Job[] {
      return events.flatMap((event) => (event.type === 'job.upsert' ? [event.job] : []));
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

const SEC = 1_000;

/** Creates `Client/Job` with one file and lets the watcher see it. Returns when the job exists. */
async function arrive(h: Harness, rel = 'Acme/Spring', file = 'a.mp4', bytes = 100) {
  h.write(`${rel}/${file}`, bytes);
  h.emit('add', `${rel}/${file}`);
  await h.advance(500);
  return h.job(rel) as Job;
}

// --- the acceptance test -----------------------------------------------------------------------

describe('inbox watcher: arriving and settling', () => {
  it('stays arriving while files are copied in over 90 s, and is queued 60 s after the last one', async () => {
    const h = createHarness();
    await h.watcher.start();
    const rel = 'Acme/Spring';

    // A clip lands every 15 s, from t = 0 to t = 90 s.
    for (let i = 0; i <= 6; i += 1) {
      h.write(`${rel}/clip${i}.mp4`, 1_000 * (i + 1));
      h.emit('add', `${rel}/clip${i}.mp4`);
      await h.advance(15 * SEC);
      expect(h.state(rel), `after clip ${i}`).toBe('arriving');
    }
    expect(h.job(rel)?.inputs).toEqual({ video: 7, audio: 0, image: 0, doc: 0 });
    expect(h.job(rel)?.sizeBytes).toBe(1_000 * (1 + 2 + 3 + 4 + 5 + 6 + 7));

    // The last clip landed at t = 90 s; its rescan (and FILES_CHANGED) ran 0.5 s later.
    const lastChange = Date.parse(T0) + 90 * SEC + 500;
    expect(Date.parse(h.job(rel)?.lastChangeAt ?? '')).toBe(lastChange);

    // We are at t = 105 s. Just before the 60 s of quiet are up it is still arriving...
    await h.advance(lastChange + 60 * SEC - h.now() - 1);
    expect(h.state(rel)).toBe('arriving');
    expect(h.job(rel)?.settledAt).toBeNull();

    // ...and one millisecond later it is queued.
    await h.advance(1);
    const queued = h.job(rel);
    expect(queued?.state).toBe('queued');
    expect(Date.parse(queued?.settledAt ?? '')).toBe(lastChange + 60 * SEC);
    expect(queued?.placeInLine).toBe(1);

    // Everything was published, in order: created arriving, a refresh per clip, then queued.
    const published = h.upserts();
    expect(published[0]?.state).toBe('arriving');
    expect(published.slice(0, -1).every((job) => job.state === 'arriving')).toBe(true);
    expect(published.at(-1)?.state).toBe('queued');
    expect(h.events.every((event) => event.type === 'job.upsert')).toBe(true);
  });

  it('uses settleMs, not the default 60 s', async () => {
    const h = createHarness({ settleMs: 5 * SEC });
    await h.watcher.start();
    await arrive(h);
    await h.advance(4 * SEC);
    expect(h.state('Acme/Spring')).toBe('arriving');
    await h.advance(1 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
  });

  it('shows an empty job folder as an arriving job and queues it after the quiet time', async () => {
    const h = createHarness();
    await h.watcher.start();
    h.mkdir('Acme/Empty');
    h.emit('addDir', 'Acme');
    h.emit('addDir', 'Acme/Empty');
    await h.advance(500);
    expect(h.job('Acme/Empty')).toMatchObject({
      state: 'arriving',
      inputs: { video: 0, audio: 0, image: 0, doc: 0 },
      sizeBytes: 0,
    });
    await h.advance(60 * SEC);
    expect(h.state('Acme/Empty')).toBe('queued');
  });

  it('takes a queued job back to arriving when its files change, and queues it again 60 s later', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h);
    await h.advance(60 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
    const firstSettled = h.job('Acme/Spring')?.settledAt;

    h.write('Acme/Spring/more.mp4', 50);
    h.emit('add', 'Acme/Spring/more.mp4');
    await h.advance(500);
    expect(h.job('Acme/Spring')).toMatchObject({ state: 'arriving', settledAt: null });
    expect(h.job('Acme/Spring')?.inputs.video).toBe(2);

    await h.advance(59 * SEC);
    expect(h.state('Acme/Spring')).toBe('arriving');
    await h.advance(1 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
    expect(h.job('Acme/Spring')?.settledAt).not.toBe(firstSettled);
  });

  it('restarts the quiet time when files change without changing the counts or the size', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h);
    const created = h.job('Acme/Spring');

    // 30 s later the same bytes are written over the same file: nothing the scan can tell apart.
    await h.advance(30 * SEC);
    h.write('Acme/Spring/a.mp4', 100);
    h.emit('change', 'Acme/Spring/a.mp4');
    await h.advance(500);

    const touched = h.job('Acme/Spring');
    expect(touched?.state).toBe('arriving');
    expect(Date.parse(touched?.lastChangeAt ?? '')).toBeGreaterThan(
      Date.parse(created?.lastChangeAt ?? ''),
    );
    // The original 60 s would be over at t = 60.5 s; the touch moved it to t = 91 s.
    await h.advance(40 * SEC);
    expect(h.state('Acme/Spring')).toBe('arriving');
    await h.advance(20 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
  });

  it('does not queue a job at the moment a rescan is about to say it changed again', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h);
    // The timer is due at t = 60.5 s. At t = 60.2 s another file lands; its rescan runs at 60.7 s.
    await h.advance(60 * SEC - 300);
    h.write('Acme/Spring/b.mp4', 20);
    h.emit('add', 'Acme/Spring/b.mp4');
    await h.advance(2 * SEC);
    expect(h.state('Acme/Spring')).toBe('arriving');
    // It never went to queued and back.
    expect(
      h
        .upserts()
        .map((job) => job.state)
        .includes('queued'),
    ).toBe(false);

    await h.advance(60 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
  });

  it('keeps one job per folder and a timer per job', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h, 'Acme/Spring');
    await arrive(h, 'Acme/Summer');
    await arrive(h, 'Globex/Launch');
    expect(h.repo.getAll()).toHaveLength(3);
    expect(h.timers.count).toBe(3);

    await h.advance(60 * SEC);
    expect(h.repo.getAll().map((job) => job.state)).toEqual(['queued', 'queued', 'queued']);
    expect(h.timers.count).toBe(0);
  });
});

describe('inbox watcher: the series name rule', () => {
  /** A stand-in for K1's rule: every job it is asked about joins series s1 as episode 6. */
  function joinAll(calls: string[]) {
    return (job: Job, repo: JobRepository): Job => {
      calls.push(job.state);
      return repo.setSeries(job.id, { seriesId: 's1', episode: 6, pinned: false });
    };
  }

  it('runs when a job is first found and when it settles, and publishes what it answers', async () => {
    const calls: string[] = [];
    const h = createHarness({ assignSeries: joinAll(calls) });
    await h.watcher.start();

    await arrive(h, 'Acme/Weekly 6');
    expect(calls).toEqual(['arriving']);
    expect(h.upserts().at(-1)).toMatchObject({ state: 'arriving', seriesId: 's1', episode: 6 });

    // A file change is neither: the rule is not asked again.
    h.write('Acme/Weekly 6/b.mp4', 10);
    h.emit('add', 'Acme/Weekly 6/b.mp4');
    await h.advance(500);
    expect(calls).toEqual(['arriving']);

    await h.advance(60 * SEC);
    expect(calls).toEqual(['arriving', 'queued']);
    expect(h.upserts().at(-1)).toMatchObject({ state: 'queued', seriesId: 's1' });
  });

  it('changes nothing when left out', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h, 'Acme/Weekly 6');
    await h.advance(60 * SEC);
    expect(h.job('Acme/Weekly 6')).toMatchObject({
      state: 'queued',
      seriesId: null,
      episode: null,
    });
  });
});

describe('inbox watcher: what it never reacts to', () => {
  it('never changes state for writes into <job>/edit/ or _Exports/, nor for dotfiles and partial downloads', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h);
    await h.advance(60 * SEC);
    const queued = h.job('Acme/Spring');
    expect(queued?.state).toBe('queued');
    const scansBefore = h.scanCalls.length;
    const eventsBefore = h.events.length;

    h.write('Acme/Spring/edit/transcripts/a.json', 10);
    h.write('Acme/Spring/edit/final.mp4', 10_000);
    h.write('Acme/Spring/Edit/preview.mp4', 10);
    h.write('_Exports/Acme/Spring.mp4', 10_000);
    h.write('Acme/Spring/.DS_Store', 10);
    h.write('Acme/Spring/b.mp4.crdownload', 10);
    h.write('Acme/loose.txt', 10);
    h.write('loose.txt', 10);
    for (const rel of [
      'Acme/Spring/edit/transcripts/a.json',
      'Acme/Spring/edit/final.mp4',
      'Acme/Spring/Edit/preview.mp4',
      '_Exports/Acme/Spring.mp4',
      'Acme/Spring/.DS_Store',
      'Acme/Spring/b.mp4.crdownload',
      'Acme/loose.txt',
      'loose.txt',
    ]) {
      h.emit('add', rel);
      h.emit('change', rel);
    }
    h.emit('addDir', 'Acme/Spring/edit');
    h.emit('addDir', '_Exports/Acme');

    // Nothing was even scheduled...
    expect(h.timers.count).toBe(0);
    await h.advance(10 * 60 * SEC);
    // ...so nothing was scanned, published or changed.
    expect(h.scanCalls.length).toBe(scansBefore);
    expect(h.events.length).toBe(eventsBefore);
    expect(h.job('Acme/Spring')).toEqual(queued);
  });

  it('ignores file changes in jobs that are editing, in review, ready, failed or cancelled, and logs them', async () => {
    const h = createHarness();
    await h.watcher.start();

    const editing = await arrive(h, 'Acme/Editing');
    const reviewing = await arrive(h, 'Acme/Review');
    const done = await arrive(h, 'Acme/Done');
    const failed = await arrive(h, 'Acme/Failed');
    const stopped = await arrive(h, 'Acme/Stopped');
    await h.advance(60 * SEC);
    for (const job of [editing, reviewing, done, failed, stopped]) {
      h.repo.applyTransition(job.id, { type: 'START' });
    }
    h.repo.applyTransition(reviewing.id, {
      type: 'PREVIEW_READY',
      preview: { durationSec: 28.4, width: 1080, height: 1920 },
    });
    h.repo.applyTransition(done.id, {
      type: 'SUCCEED',
      output: { fileName: 'x.mp4', durationSec: 1, width: 1, height: 1, sizeBytes: 1 },
    });
    h.repo.applyTransition(failed.id, { type: 'FAIL', step: 3, error: 'boom' });
    h.repo.applyTransition(stopped.id, { type: 'CANCEL' });

    const before = h.repo.getAll();
    const eventsBefore = h.events.length;
    for (const rel of ['Acme/Editing', 'Acme/Review', 'Acme/Done', 'Acme/Failed', 'Acme/Stopped']) {
      h.write(`${rel}/late.mp4`, 77);
      h.emit('add', `${rel}/late.mp4`);
    }
    await h.advance(2 * SEC);

    expect(h.repo.getAll()).toEqual(before);
    expect(h.events.length).toBe(eventsBefore);
    expect(h.timers.count).toBe(0);
    expect(h.lines.filter((line) => line.msg?.includes('ignored')).length).toBe(5);
  });
});

describe('inbox watcher: the _Style folder', () => {
  const isDir = (h: Harness, rel: string) => {
    try {
      return statSync(join(h.inbox, rel)).isDirectory();
    } catch {
      return false;
    }
  };

  it('makes it in a client folder that appears, next to its jobs, and never lists it as a job', async () => {
    const h = createHarness();
    await h.watcher.start();
    h.write('Acme/Spring/a.mp4', 100);
    h.emit('addDir', 'Acme');
    h.emit('addDir', 'Acme/Spring');
    await h.advance(500);

    expect(isDir(h, 'Acme/_Style')).toBe(true);
    expect(h.state('Acme/Spring')).toBe('arriving');
    expect(h.repo.getAll().map((job) => job.relPath)).toEqual(['Acme/Spring']);
    expect(h.scanCalls).not.toContain('Acme/_Style');
  });

  it('makes it in an empty client folder too, and leaves one that is there alone', async () => {
    const h = createHarness();
    await h.watcher.start();
    h.mkdir('Beta');
    h.emit('addDir', 'Beta');
    h.write('Acme/_Style/style.md', 5);
    h.emit('addDir', 'Acme');
    await h.advance(500);

    expect(isDir(h, 'Beta/_Style')).toBe(true);
    expect(readdirSync(join(h.inbox, 'Acme', '_Style'))).toEqual(['style.md']);
    expect(h.repo.getAll()).toEqual([]);
  });

  it('does not bring a client folder back that was deleted before the sweep ran', async () => {
    const h = createHarness();
    await h.watcher.start();
    h.mkdir('Acme');
    h.emit('addDir', 'Acme');
    h.remove('Acme');
    await h.advance(500);

    expect(existsSync(join(h.inbox, 'Acme'))).toBe(false);
  });

  it('is not made for what the inbox rules skip', async () => {
    const h = createHarness();
    await h.watcher.start();
    h.mkdir('_Exports/Acme');
    h.mkdir('.hidden');
    h.emit('addDir', '_Exports');
    h.emit('addDir', '_Exports/Acme');
    h.emit('addDir', '.hidden');
    await h.advance(2 * SEC);

    expect(readdirSync(join(h.inbox, '_Exports', 'Acme'))).toEqual([]);
    expect(readdirSync(join(h.inbox, '_Exports'))).toEqual(['Acme']);
    expect(readdirSync(join(h.inbox, '.hidden'))).toEqual([]);
  });

  it('never reacts to what happens inside it', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h);
    await h.advance(60 * SEC);
    const queued = h.job('Acme/Spring');
    const scansBefore = h.scanCalls.length;
    const eventsBefore = h.events.length;

    h.write('Acme/_Style/style.md', 10);
    h.write('Acme/_Style/kit/slot_1/index.html', 10);
    h.mkdir('Acme/_Style/references');
    h.emit('addDir', 'Acme/_Style');
    h.emit('add', 'Acme/_Style/style.md');
    h.emit('change', 'Acme/_Style/style.md');
    h.emit('add', 'Acme/_Style/kit/slot_1/index.html');
    h.emit('addDir', 'Acme/_Style/references');

    expect(h.timers.count).toBe(0);
    await h.advance(10 * 60 * SEC);
    expect(h.scanCalls.length).toBe(scansBefore);
    expect(h.events.length).toBe(eventsBefore);
    expect(h.job('Acme/Spring')).toEqual(queued);
    expect(h.repo.getAll()).toHaveLength(1);
  });

  it('passes the files dropped into it to onStyleEvent, and only those, without touching a job', async () => {
    const styleEvents: StyleFsEvent[] = [];
    const h = createHarness({ onStyleEvent: (event) => styleEvents.push(event) });
    await h.watcher.start();
    await arrive(h);
    const before = h.job('Acme/Spring');
    const eventsBefore = h.events.length;

    h.write('Acme/_Style/logo.png', 10);
    h.emit('add', 'Acme/_Style/logo.png');
    h.emit('change', 'Acme/_Style/logo.png');
    h.emit('add', 'Acme/_Style/style.md');
    h.emit('add', 'Acme/_Style/kit/slot_1/index.html');
    h.emit('addDir', 'Acme/_Style/references');
    h.emit('add', 'Acme/_Style/.DS_Store');
    h.emit('unlink', 'Acme/_Style/old.pdf');
    await h.advance(10 * 60 * SEC);

    expect(styleEvents).toEqual([
      { kind: 'add', client: 'Acme', path: 'logo.png' },
      { kind: 'change', client: 'Acme', path: 'logo.png' },
      { kind: 'unlink', client: 'Acme', path: 'old.pdf' },
    ]);
    expect(h.events.length).toBe(eventsBefore + 1);
    expect(h.job('Acme/Spring')?.state).toBe('queued');
    expect(h.job('Acme/Spring')?.inputs).toEqual(before?.inputs);
    expect(h.scanCalls.filter((call) => call.includes('_Style'))).toEqual([]);
  });

  it('logs a style handler that throws, and carries on', async () => {
    const h = createHarness({
      onStyleEvent: () => {
        throw new Error('boom');
      },
    });
    await h.watcher.start();
    h.emit('add', 'Acme/_Style/logo.png');
    await arrive(h);
    expect(h.lines.some((line) => line.msg === 'a style folder event failed')).toBe(true);
    expect(h.state('Acme/Spring')).toBe('arriving');
  });

  it('is not looked at when a client folder is swept for a job that vanished', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h);
    h.remove('Acme/Spring');
    h.emit('addDir', 'Acme');
    await h.advance(500);

    expect(h.job('Acme/Spring')).toBeNull();
    expect(h.scanCalls.filter((call) => call.includes('_Style'))).toEqual([]);
    expect(isDir(h, 'Acme/_Style')).toBe(true);
  });
});

describe('inbox watcher: coalescing events', () => {
  it('rescans a job once for a burst of events', async () => {
    const h = createHarness();
    await h.watcher.start();
    h.write('Acme/Spring/a.mp4', 10);
    for (let i = 0; i < 20; i += 1) {
      h.emit('change', 'Acme/Spring/a.mp4');
      await h.advance(20);
    }
    expect(h.scanCalls).toEqual([]);
    await h.advance(500);
    expect(h.scanCalls).toEqual(['Acme/Spring']);
  });

  it('keeps rescanning every window while a copy goes on, so the job grows in the list', async () => {
    const h = createHarness();
    await h.watcher.start();
    // An event every 100 ms for 1.3 s: windows open at 0, 600 and 1200 ms and close 500 ms later.
    for (let i = 0; i <= 13; i += 1) {
      h.write('Acme/Spring/big.mp4', 100 * (i + 1));
      h.emit('change', 'Acme/Spring/big.mp4');
      await h.advance(100);
    }
    expect(h.scanCalls).toHaveLength(2);
    await h.advance(500);
    expect(h.scanCalls).toHaveLength(3);
    expect(h.job('Acme/Spring')?.sizeBytes).toBe(1_400);
  });

  it('scans different jobs separately, each once', async () => {
    const h = createHarness();
    await h.watcher.start();
    h.write('Acme/Spring/a.mp4');
    h.write('Acme/Summer/a.mp4');
    h.write('Globex/Launch/a.mp4');
    for (const rel of ['Acme/Spring', 'Acme/Summer', 'Globex/Launch']) {
      h.emit('add', `${rel}/a.mp4`);
      h.emit('change', `${rel}/a.mp4`);
    }
    await h.advance(500);
    expect([...h.scanCalls].sort()).toEqual(['Acme/Spring', 'Acme/Summer', 'Globex/Launch']);
  });

  it('runs a second rescan for events that arrive while the first is running', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const h = createHarness({
      scan: async (_client, _name, real) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return real();
      },
    });
    await h.watcher.start();
    h.write('Acme/Spring/a.mp4', 10);
    h.emit('add', 'Acme/Spring/a.mp4');
    // The window closes and the first rescan starts, but is held up.
    const pendingAdvance = h.advance(500);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);

    // A file lands meanwhile; its window closes and asks for another rescan.
    h.write('Acme/Spring/b.mp4', 20);
    h.emit('add', 'Acme/Spring/b.mp4');
    h.clock.tick(500);
    h.timers.take(h.now())?.callback();
    expect(calls).toBe(1);

    release();
    await pendingAdvance;
    await h.watcher.whenIdle();
    expect(calls).toBe(2);
    expect(h.job('Acme/Spring')?.inputs.video).toBe(2);
  });
});

// --- hold ----------------------------------------------------------------------------------

describe('inbox watcher: held jobs', () => {
  /** What the API does for Hold/Release: apply the action, then publish the job. */
  function act(h: Harness, id: string, type: 'HOLD' | 'RELEASE', publish = true): Job {
    const job = h.repo.applyTransition(id, { type });
    if (publish) h.bus.publish({ type: 'job.upsert', job });
    return job;
  }

  it('drops the timer when the job is held (published), and never queues it', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    expect(h.timers.count).toBe(1);

    act(h, job.id, 'HOLD');
    expect(h.timers.count).toBe(0);
    await h.advance(10 * 60 * SEC);
    expect(h.state('Acme/Spring')).toBe('held');
  });

  it('leaves a held job held when a timer fires that was never dropped', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);

    act(h, job.id, 'HOLD', false);
    expect(h.timers.count).toBe(1);
    await h.advance(60 * SEC);
    expect(h.state('Acme/Spring')).toBe('held');
    expect(h.timers.count).toBe(0);
  });

  it('records changes to a held job without leaving held, and keeps no timer for it', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    act(h, job.id, 'HOLD');
    await h.advance(20 * SEC);

    h.write('Acme/Spring/more.mp4', 40);
    h.emit('add', 'Acme/Spring/more.mp4');
    await h.advance(500);

    const held = h.job('Acme/Spring');
    expect(held?.state).toBe('held');
    expect(held?.inputs.video).toBe(2);
    expect(Date.parse(held?.lastChangeAt ?? '')).toBe(h.now());
    expect(h.timers.count).toBe(0);
  });

  it('settles a released job once the quiet time since the last change is over', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    act(h, job.id, 'HOLD');
    // Files change 20 s into the hold; the release comes 20 s after that: still inside 60 s.
    await h.advance(20 * SEC);
    h.write('Acme/Spring/more.mp4', 40);
    h.emit('add', 'Acme/Spring/more.mp4');
    await h.advance(500 + 20 * SEC);

    const released = act(h, job.id, 'RELEASE');
    expect(released.state).toBe('arriving');
    // The Release was published, so the watcher armed the rest of the quiet time (~40 s).
    expect(h.timers.count).toBe(1);
    await h.advance(39 * SEC);
    expect(h.state('Acme/Spring')).toBe('arriving');
    await h.advance(1 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
  });

  it('queues a job released after a long quiet time right away (the machine decides)', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    act(h, job.id, 'HOLD');
    await h.advance(5 * 60 * SEC);

    const released = act(h, job.id, 'RELEASE');
    expect(released.state).toBe('queued');
    expect(h.timers.count).toBe(0);
  });
});

describe('inbox watcher: Start now', () => {
  /** What the API does for Start now: apply the action, then publish the job. */
  function start(h: Harness, id: string, publish = true): Job {
    const job = h.repo.applyTransition(id, eventForAction('start'));
    if (publish) h.bus.publish({ type: 'job.upsert', job });
    return job;
  }

  const queuedUpserts = (h: Harness) => h.upserts().filter((job) => job.state === 'queued');

  it('drops the settle timer when the job is started (published), and the job stays as started', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    await h.advance(10 * SEC);
    expect(h.timers.count).toBe(1);

    const started = start(h, job.id);

    expect(started.state).toBe('queued');
    expect(h.timers.count).toBe(0);
    const startedAt = h.job('Acme/Spring')?.settledAt;
    expect(startedAt).toBe(new Date(h.now()).toISOString());

    // The quiet time would have run out at 60 s; nothing happens then or much later.
    await h.advance(10 * 60 * SEC);
    expect(h.job('Acme/Spring')).toMatchObject({ state: 'queued', settledAt: startedAt });
    expect(h.timers.count).toBe(0);
    // The only queued upsert is the one the API published: the timer never fired a second one.
    expect(queuedUpserts(h)).toHaveLength(1);
  });

  it('does nothing when a timer that was never dropped fires (the state is checked again)', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    await h.advance(10 * SEC);

    start(h, job.id, false);
    const startedAt = h.job('Acme/Spring')?.settledAt;
    expect(h.timers.count).toBe(1);
    await h.advance(60 * SEC);

    expect(h.job('Acme/Spring')).toMatchObject({ state: 'queued', settledAt: startedAt });
    expect(h.timers.count).toBe(0);
    expect(queuedUpserts(h)).toHaveLength(0);
    expect(h.lines.filter((line) => line.level === 'error')).toEqual([]);
  });

  it('a later file change sends the started job back to arriving, and it settles 60 s after that', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    await h.advance(10 * SEC);
    start(h, job.id);
    const startedAt = h.job('Acme/Spring')?.settledAt;
    await h.advance(5 * SEC);

    h.write('Acme/Spring/more.mp4', 50);
    h.emit('add', 'Acme/Spring/more.mp4');
    await h.advance(500);

    expect(h.job('Acme/Spring')).toMatchObject({ state: 'arriving', settledAt: null });
    expect(h.job('Acme/Spring')?.inputs.video).toBe(2);
    expect(h.timers.count).toBe(1);

    await h.advance(59 * SEC);
    expect(h.state('Acme/Spring')).toBe('arriving');
    await h.advance(1 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
    expect(h.job('Acme/Spring')?.settledAt).not.toBe(startedAt);
  });

  it('only touches the job that was started: another arriving job still settles on its own timer', async () => {
    const h = createHarness();
    await h.watcher.start();
    const first = await arrive(h, 'Acme/First');
    await arrive(h, 'Acme/Second');
    expect(h.timers.count).toBe(2);

    start(h, first.id);

    expect(h.timers.count).toBe(1);
    await h.advance(60 * SEC);
    expect(h.state('Acme/First')).toBe('queued');
    expect(h.state('Acme/Second')).toBe('queued');
  });
});

// --- deleting ------------------------------------------------------------------------------

describe('inbox watcher: removed folders', () => {
  it('removes an arriving job, drops its timer and publishes job.remove', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);
    expect(h.timers.count).toBe(1);

    h.remove('Acme/Spring');
    h.emit('unlink', 'Acme/Spring/a.mp4');
    h.emit('unlinkDir', 'Acme/Spring');
    await h.advance(500);

    expect(h.repo.get(job.id)).toBeNull();
    expect(h.timers.count).toBe(0);
    expect(h.events.at(-1)).toEqual({ type: 'job.remove', id: job.id });
    await h.advance(10 * 60 * SEC);
    expect(h.repo.getAll()).toEqual([]);
  });

  it('removes queued and held jobs too', async () => {
    const h = createHarness();
    await h.watcher.start();
    const queued = await arrive(h, 'Acme/Queued');
    const held = await arrive(h, 'Acme/Held');
    h.repo.applyTransition(held.id, { type: 'HOLD' });
    await h.advance(60 * SEC);
    expect(h.state('Acme/Queued')).toBe('queued');

    h.remove('Acme/Queued');
    h.remove('Acme/Held');
    h.emit('unlinkDir', 'Acme/Queued');
    h.emit('unlinkDir', 'Acme/Held');
    await h.advance(500);

    expect(h.repo.get(queued.id)).toBeNull();
    expect(h.repo.get(held.id)).toBeNull();
    expect(h.events.filter((event) => event.type === 'job.remove')).toHaveLength(2);
  });

  it('removes a failed job too', async () => {
    const h = createHarness();
    await h.watcher.start();
    const failed = await arrive(h, 'Acme/Failed');
    await h.advance(60 * SEC);
    h.repo.applyTransition(failed.id, { type: 'START' });
    h.repo.applyTransition(failed.id, { type: 'FAIL', step: 5, error: 'Claude exited with 1' });

    h.remove('Acme/Failed');
    h.emit('unlinkDir', 'Acme/Failed');
    await h.advance(500);

    expect(h.repo.get(failed.id)).toBeNull();
  });

  it('marks a job that is being edited failed instead of removing it, and tells the worker', async () => {
    const removed: Job[] = [];
    const h = createHarness({ onFolderRemovedWhileEditing: (job) => removed.push(job) });
    await h.watcher.start();
    const job = await arrive(h);
    await h.advance(60 * SEC);
    h.repo.applyTransition(job.id, { type: 'START' });
    h.repo.applyTransition(job.id, { type: 'PROGRESS', step: 4, sub: null });
    const eventsBefore = h.events.length;

    h.remove('Acme/Spring');
    h.emit('unlinkDir', 'Acme/Spring');
    await h.advance(500);

    const failed = h.repo.get(job.id);
    expect(failed).toMatchObject({
      state: 'failed',
      step: 4,
      failedAt: 4,
      error: FOLDER_REMOVED_ERROR,
    });
    expect(failed?.error).toBe('Folder was removed');
    expect(h.events.slice(eventsBefore)).toEqual([{ type: 'job.upsert', job: failed }]);
    expect(removed).toEqual([failed]);
  });

  it('keeps the failure on screen when more events arrive for the same deletion', async () => {
    const removed: Job[] = [];
    const h = createHarness({ onFolderRemovedWhileEditing: (job) => removed.push(job) });
    await h.watcher.start();
    const job = await arrive(h);
    await h.advance(60 * SEC);
    h.repo.applyTransition(job.id, { type: 'START' });

    h.remove('Acme');
    h.emit('unlinkDir', 'Acme/Spring');
    await h.advance(500);
    expect(h.state('Acme/Spring')).toBe('failed');

    // Straggling events: the client folder, then the job again.
    h.emit('unlinkDir', 'Acme');
    await h.advance(500);
    h.emit('unlink', 'Acme/Spring/late.mp4');
    await h.advance(500);

    expect(h.job('Acme/Spring')).toMatchObject({ state: 'failed', error: FOLDER_REMOVED_ERROR });
    expect(removed).toHaveLength(1);
  });

  it('survives a worker hook that throws', async () => {
    const h = createHarness({
      onFolderRemovedWhileEditing: () => {
        throw new Error('hook failed');
      },
    });
    await h.watcher.start();
    const job = await arrive(h);
    await h.advance(60 * SEC);
    h.repo.applyTransition(job.id, { type: 'START' });

    h.remove('Acme/Spring');
    h.emit('unlinkDir', 'Acme/Spring');
    await h.advance(500);

    expect(h.state('Acme/Spring')).toBe('failed');
    expect(h.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('keeps a job whose folder is deleted and put back within the window', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = await arrive(h);

    h.remove('Acme/Spring');
    h.emit('unlinkDir', 'Acme/Spring');
    await h.advance(100);
    h.write('Acme/Spring/a.mp4', 100);
    h.emit('addDir', 'Acme/Spring');
    await h.advance(500);

    expect(h.repo.get(job.id)).not.toBeNull();
    expect(h.events.some((event) => event.type === 'job.remove')).toBe(false);
  });

  it('keeps every job when the inbox itself has gone missing', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h, 'Acme/Spring');
    await arrive(h, 'Globex/Launch');
    const before = h.repo.getAll();
    const eventsBefore = h.events.length;

    h.remove('');
    h.emit('unlinkDir', 'Acme/Spring');
    h.emit('unlinkDir', 'Globex');
    await h.advance(500);

    expect(h.repo.getAll()).toEqual(before);
    expect(h.events.length).toBe(eventsBefore);
    expect(
      h.lines.some((line) => line.level === 'warn' && line.msg?.includes('inbox is missing')),
    ).toBe(true);
  });

  it('removes every job of a client folder that vanished, and finds the jobs of one that appeared', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h, 'Acme/Spring');
    await arrive(h, 'Acme/Summer');
    await arrive(h, 'Globex/Launch');

    h.remove('Acme');
    h.emit('unlinkDir', 'Acme');
    await h.advance(500);
    expect(h.repo.getAll().map((job) => job.relPath)).toEqual(['Globex/Launch']);

    // A client folder moved in with its jobs: one event for the folder, none for what is inside.
    h.write('Initech/One/a.mp4', 10);
    h.write('Initech/Two/a.mp4', 10);
    h.emit('addDir', 'Initech');
    await h.advance(500);
    expect(
      h.repo
        .getAll()
        .map((job) => job.relPath)
        .sort(),
    ).toEqual(['Globex/Launch', 'Initech/One', 'Initech/Two']);
  });
});

// --- timers at boot, stop, bus ---------------------------------------------------------------

describe('inbox watcher: boot and shutdown', () => {
  it('armAll arms the arriving jobs of the database, due 60 s after their last change', async () => {
    const h = createHarness();
    // Two jobs that were arriving when the engine stopped, one a minute ago and one just now.
    h.repo.upsertFromScan(makeScan('Acme', 'Old'));
    h.clock.tick(45 * SEC);
    h.repo.upsertFromScan(makeScan('Acme', 'Recent'));
    const held = h.repo.upsertFromScan(makeScan('Acme', 'Held')).job;
    h.repo.applyTransition(held.id, { type: 'HOLD' });
    h.clock.tick(30 * SEC);
    // 'Old' changed 75 s ago, 'Recent' 30 s ago.

    h.watcher.armAll();
    expect(h.timers.count).toBe(2);

    // The overdue one settles at once; the other has 30 s to go.
    await h.advance(0);
    expect(h.state('Acme/Old')).toBe('queued');
    expect(h.state('Acme/Recent')).toBe('arriving');
    await h.advance(30 * SEC - 1);
    expect(h.state('Acme/Recent')).toBe('arriving');
    await h.advance(1);
    expect(h.state('Acme/Recent')).toBe('queued');
    expect(h.state('Acme/Held')).toBe('held');
  });

  it('arming twice does not add timers or restart the wait', async () => {
    const h = createHarness();
    const job = h.repo.upsertFromScan(makeScan('Acme', 'Spring')).job;
    h.watcher.armSettleTimer(job);
    h.clock.tick(10 * SEC);
    h.watcher.armSettleTimer(job);
    h.watcher.armAll();
    expect(h.timers.count).toBe(1);
    await h.advance(50 * SEC);
    expect(h.state('Acme/Spring')).toBe('queued');
  });

  it('arms and disarms from job.upsert and job.remove on the bus, whoever publishes them', async () => {
    const h = createHarness();
    await h.watcher.start();
    const job = h.repo.upsertFromScan(makeScan('Acme', 'Spring')).job;

    h.bus.publish({ type: 'job.upsert', job });
    expect(h.timers.count).toBe(1);
    h.bus.publish({ type: 'job.remove', id: job.id });
    expect(h.timers.count).toBe(0);
  });

  it('stop drops every timer, stops the source and ignores events afterwards', async () => {
    const h = createHarness();
    await h.watcher.start();
    await arrive(h);
    h.write('Acme/Spring/b.mp4', 10);
    h.emit('add', 'Acme/Spring/b.mp4');
    expect(h.timers.count).toBe(2); // the settle timer and the open window

    await h.watcher.stop();
    expect(h.timers.count).toBe(0);
    expect(h.source.stopped).toBe(1);

    const scans = h.scanCalls.length;
    const events = h.events.length;
    h.emit('add', 'Acme/Spring/b.mp4');
    h.bus.publish({ type: 'job.upsert', job: h.job('Acme/Spring') as Job });
    await h.advance(10 * 60 * SEC);
    expect(h.scanCalls.length).toBe(scans);
    expect(h.state('Acme/Spring')).toBe('arriving');
    expect(h.events.length).toBe(events + 1);

    await h.watcher.stop();
    expect(h.source.stopped).toBe(1);
    await expect(h.watcher.start()).rejects.toThrow(/stopped/);
  });

  it('stop waits for a rescan that is running and does not write after it', async () => {
    let release: () => void = () => {};
    const h = createHarness({
      scan: async (_client, _name, real) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return real();
      },
    });
    await h.watcher.start();
    h.write('Acme/Spring/a.mp4', 10);
    h.emit('add', 'Acme/Spring/a.mp4');
    const pendingAdvance = h.advance(500);
    await new Promise((resolve) => setImmediate(resolve));

    let stopped = false;
    const stopping = h.watcher.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    release();
    await stopping;
    await pendingAdvance;
    expect(h.repo.getAll()).toEqual([]);
  });

  it('start fails when the source cannot start, and leaves nothing subscribed', async () => {
    const h = createHarness();
    h.source.failStart = new Error('no inbox');
    await expect(h.watcher.start()).rejects.toThrow('no inbox');

    const job = h.repo.upsertFromScan(makeScan('Acme', 'Spring')).job;
    h.bus.publish({ type: 'job.upsert', job });
    expect(h.timers.count).toBe(0);
  });

  it('rejects settings that make no sense', () => {
    const base = createHarness();
    const make = (settleMs: number, debounceMs?: number) =>
      createInboxWatcher({
        inboxPath: base.inbox,
        exportsDir: base.exportsDir,
        settleMs,
        debounceMs,
        repo: base.repo,
        bus: base.bus,
      });
    expect(() => make(-1)).toThrow(RangeError);
    expect(() => make(Number.NaN)).toThrow(RangeError);
    expect(() => make(1_000, -5)).toThrow(RangeError);
    expect(() => make(0, 0)).not.toThrow();
  });
});

describe('inbox watcher: when a scan fails', () => {
  it('logs it and keeps going: no job is made or lost, and the next event works', async () => {
    let fail = true;
    const h = createHarness({
      scan: async (_client, _name, real) => {
        if (fail) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return real();
      },
    });
    await h.watcher.start();
    h.write('Acme/Spring/a.mp4', 10);
    h.emit('add', 'Acme/Spring/a.mp4');
    await h.advance(500);
    expect(h.repo.getAll()).toEqual([]);
    expect(h.lines.some((line) => line.level === 'warn')).toBe(true);

    fail = false;
    h.emit('add', 'Acme/Spring/a.mp4');
    await h.advance(500);
    expect(h.state('Acme/Spring')).toBe('arriving');

    // An existing job is not touched by a failing scan either.
    fail = true;
    const before = h.job('Acme/Spring');
    h.emit('change', 'Acme/Spring/a.mp4');
    await h.advance(500);
    expect(h.job('Acme/Spring')).toEqual(before);
  });
});

// --- the tripwire (CVP-94) ---------------------------------------------------------------------

describe('inbox watcher: a new folder while an edit is running', () => {
  const WARNING =
    'a new folder appeared in the inbox while an edit is running; the edit may have written it';

  /** Brings `rel` in, lets it settle and starts editing it. */
  async function startEditing(h: Harness, rel = 'Acme/Spring') {
    const job = await arrive(h, rel);
    await h.advance(60 * SEC);
    return h.repo.applyTransition(job.id, { type: 'START' });
  }

  const warnings = (h: Harness) => h.lines.filter((line) => line.msg === WARNING);

  it('warns once for a new client folder, naming the folder and the editing job', async () => {
    const h = createHarness();
    await h.watcher.start();
    const editing = await startEditing(h);

    // V4: a stray `cd` made <inbox>/<client>/package, a client folder with a job in it.
    h.mkdir('מאפיית/package');
    h.write('מאפיית/package/index.json');
    h.emit('addDir', 'מאפיית');
    h.emit('addDir', 'מאפיית/package');
    h.emit('add', 'מאפיית/package/index.json');

    expect(warnings(h)).toEqual([
      {
        level: 'warn',
        msg: WARNING,
        obj: { folder: 'מאפיית', editingJobId: editing.id, editingRelPath: 'Acme/Spring' },
      },
    ]);
  });

  it('is only a log line: the edit and the new folder are handled as ever', async () => {
    const h = createHarness();
    await h.watcher.start();
    const editing = await startEditing(h);
    const eventsBefore = h.events.length;

    h.write('Stray/package/a.mp4', 10);
    h.emit('addDir', 'Stray');
    h.emit('addDir', 'Stray/package');
    expect(warnings(h)).toHaveLength(1);
    await h.advance(500);

    // The editing job is untouched and nothing was published for it...
    expect(h.repo.get(editing.id)).toEqual(editing);
    expect(h.events.slice(eventsBefore).map((event) => event.type)).toEqual(['job.upsert']);
    // ...and the new folder became an arriving job, as it would without the warning.
    expect(h.job('Stray/package')).toMatchObject({ state: 'arriving', client: 'Stray' });
    expect(warnings(h)).toHaveLength(1);
  });

  it('warns for a new job folder beside the editing job, in the same client folder', async () => {
    const h = createHarness();
    await h.watcher.start();
    const editing = await startEditing(h);

    h.mkdir('Acme/package');
    h.emit('addDir', 'Acme/package');

    expect(warnings(h)).toEqual([
      {
        level: 'warn',
        msg: WARNING,
        obj: { folder: 'Acme/package', editingJobId: editing.id, editingRelPath: 'Acme/Spring' },
      },
    ]);
    await h.advance(500);
    expect(h.state('Acme/package')).toBe('arriving');
    expect(h.repo.get(editing.id)).toEqual(editing);
  });

  it('does not warn when nothing is being edited', async () => {
    const h = createHarness();
    await h.watcher.start();

    // A queued job, a job whose edit failed and a job still arriving: none of them is editing.
    const failed = await arrive(h, 'Acme/Failed');
    await arrive(h, 'Acme/Queued');
    await h.advance(60 * SEC);
    h.repo.applyTransition(failed.id, { type: 'START' });
    h.repo.applyTransition(failed.id, { type: 'FAIL', step: 2, error: 'boom' });
    await arrive(h, 'Acme/Arriving');
    expect([h.state('Acme/Failed'), h.state('Acme/Queued'), h.state('Acme/Arriving')]).toEqual([
      'failed',
      'queued',
      'arriving',
    ]);
    expect(h.repo.getEditing()).toEqual([]);

    h.mkdir('Newclient/Job');
    h.mkdir('Acme/Sibling');
    h.emit('addDir', 'Newclient');
    h.emit('addDir', 'Newclient/Job');
    h.emit('addDir', 'Acme/Sibling');
    await h.advance(500);

    expect(warnings(h)).toEqual([]);
    expect(h.state('Newclient/Job')).toBe('arriving');
  });

  it('stops warning when the edit is over', async () => {
    const h = createHarness();
    await h.watcher.start();
    const editing = await startEditing(h);

    h.emit('addDir', 'First');
    expect(warnings(h)).toHaveLength(1);

    h.repo.applyTransition(editing.id, { type: 'FAIL', step: 2, error: 'boom' });
    h.emit('addDir', 'Second');
    expect(warnings(h)).toHaveLength(1);
  });

  it('does not warn for files, or for folders inside a job, the editing one included', async () => {
    const h = createHarness();
    await h.watcher.start();
    await startEditing(h);

    for (const [kind, rel] of [
      ['add', 'Acme/Spring/new.mp4'],
      ['change', 'Acme/Spring/a.mp4'],
      ['unlink', 'Acme/Spring/a.mp4'],
      ['addDir', 'Acme/Spring/raw'],
      ['addDir', 'Acme/Spring/raw/day2'],
      ['addDir', 'Acme/Spring/edit'],
      ['addDir', 'Acme/Spring/edit/transcripts'],
      ['add', 'Acme/Spring/edit/final.mp4'],
      // Loose files at the top and in a client folder are not folders.
      ['add', 'notes.txt'],
      ['add', 'Acme/brief.pdf'],
      ['add', 'Stray'],
      ['add', 'Acme/Stray'],
      ['unlinkDir', 'Acme/Gone'],
      ['unlinkDir', 'Gone'],
    ] as const) {
      h.emit(kind, rel);
    }

    expect(warnings(h)).toEqual([]);
  });

  it("does not warn for the editing job's own folder or client, or for a job folder in another client", async () => {
    const h = createHarness();
    await h.watcher.start();
    await startEditing(h);
    await arrive(h, 'Globex/Launch');

    // The editing job's own folder and its client folder are not new, whatever is reported.
    h.emit('addDir', 'Acme');
    h.emit('addDir', 'Acme/Spring');
    // A job folder inside another client is not in the editing job's client folder.
    h.emit('addDir', 'Globex/Fresh');
    h.emit('addDir', 'Globex/Launch');

    expect(warnings(h)).toEqual([]);
  });

  it('does not warn for _Exports, whatever is written below it', async () => {
    const h = createHarness();
    await h.watcher.start();
    await startEditing(h);

    h.emit('addDir', '_Exports');
    h.emit('addDir', '_Exports/Acme');
    h.emit('add', '_Exports/Acme/Spring.mp4');
    h.emit('addDir', '_exports');

    expect(warnings(h)).toEqual([]);
  });

  it('does not warn for the configured exports folder when it is not called _Exports', async () => {
    const h = createHarness({ exportsName: 'Finished' });
    await h.watcher.start();
    await startEditing(h);

    h.emit('addDir', 'Finished');
    h.emit('addDir', 'Finished/Acme');
    h.emit('add', 'Finished/Acme/Spring.mp4');
    expect(warnings(h)).toEqual([]);

    // ...while a folder that is not the exports folder still does.
    h.emit('addDir', 'Other');
    expect(warnings(h)).toHaveLength(1);
  });

  it('does not warn for hidden folders, or for anything the watcher ignores', async () => {
    const h = createHarness();
    await h.watcher.start();
    await startEditing(h);

    h.emit('addDir', '.Trashes');
    h.emit('addDir', '.hidden');
    h.emit('addDir', 'Acme/.hidden');
    h.emit('addDir', '.hidden/Job');

    expect(warnings(h)).toEqual([]);
  });

  it('matches client and job names in Unicode NFC, so a decomposed spelling is the same folder', async () => {
    const h = createHarness();
    await h.watcher.start();
    const nfc = 'Café/Spring'.normalize('NFC');
    const nfd = 'Café'.normalize('NFD');
    const editing = await startEditing(h, nfc);

    // The editing job's own client and folder, spelled the other way: not new.
    h.emit('addDir', nfd);
    h.emit('addDir', `${nfd}/Spring`);
    expect(warnings(h)).toEqual([]);

    // A new sibling in that client is new, and the warning names the job as it is stored.
    h.emit('addDir', `${nfd}/Autumn`);
    expect(warnings(h)).toHaveLength(1);
    expect(warnings(h)[0]?.obj).toMatchObject({
      editingJobId: editing.id,
      editingRelPath: editing.relPath,
    });
  });

  it('keeps taking events when the repository cannot say what is being edited', async () => {
    const h = createHarness();
    await h.watcher.start();
    vi.spyOn(h.repo, 'getEditing').mockImplementation(() => {
      throw new Error('database is locked');
    });

    h.write('Stray/package/a.mp4', 10);
    expect(() => h.emit('addDir', 'Stray')).not.toThrow();
    await h.advance(500);

    expect(warnings(h)).toEqual([]);
    expect(h.lines.some((line) => line.level === 'error')).toBe(true);
    // The event was still handled.
    expect(h.state('Stray/package')).toBe('arriving');
  });
});

// --- generated videos (GN4): a folder with instructions and no footage ---------------------------

describe('inbox watcher: a folder with instructions and no footage (the Generate switch)', () => {
  /** The PINEWOOD shape: the client's brief, the references zip and a reference video. */
  function dropPinewood(h: Harness, rel = 'Pinewood/97 Window Ad') {
    h.write(`${rel}/PINEWOOD brief.txt`, 200);
    h.write(`${rel}/pinewood-references.zip`, 3_000);
    h.write(`${rel}/reference/reference-video-35s.mp4`, 50_000);
    h.emit('addDir', 'Pinewood');
    h.emit('addDir', rel);
    h.emit('add', `${rel}/PINEWOOD brief.txt`);
    h.emit('add', `${rel}/pinewood-references.zip`);
    h.emit('add', `${rel}/reference/reference-video-35s.mp4`);
  }

  it('becomes a job with no footage in it, and is queued after the quiet time', async () => {
    const h = createHarness({ generate: true });
    await h.watcher.start();
    dropPinewood(h);
    await h.advance(500);

    expect(h.job('Pinewood/97 Window Ad')).toMatchObject({
      state: 'arriving',
      inputs: { video: 0, audio: 0, image: 0, doc: 1 },
      sizeBytes: 200 + 3_000 + 50_000,
    });
    await h.advance(60 * SEC);
    expect(h.state('Pinewood/97 Window Ad')).toBe('queued');
  });

  it('is the same job, with its reference video counted as a video, while the switch is off', async () => {
    const h = createHarness();
    await h.watcher.start();
    dropPinewood(h);
    await h.advance(500);

    expect(h.job('Pinewood/97 Window Ad')?.inputs).toEqual({
      video: 1,
      audio: 0,
      image: 0,
      doc: 1,
    });
    await h.advance(60 * SEC);
    expect(h.state('Pinewood/97 Window Ad')).toBe('queued');
  });

  it('a zip alone is a job too', async () => {
    const h = createHarness({ generate: true });
    await h.watcher.start();
    h.write('Pinewood/Only Zip/refs.zip', 1_000);
    h.emit('add', 'Pinewood/Only Zip/refs.zip');
    await h.advance(500);

    expect(h.job('Pinewood/Only Zip')).toMatchObject({
      state: 'arriving',
      inputs: { video: 0, audio: 0, image: 0, doc: 0 },
      sizeBytes: 1_000,
    });
    await h.advance(60 * SEC);
    expect(h.state('Pinewood/Only Zip')).toBe('queued');
  });
});
