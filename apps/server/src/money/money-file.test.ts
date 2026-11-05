import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MONEY, type MoneyFile } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DirWatcher,
  MONEY_LAST_GOOD_FILE_NAME,
  MONEY_WATCH_DEBOUNCE_MS,
  MoneyFileLoader,
  moneyFilePath,
  moneyLastGoodPath,
  readMoneyFile,
  type WatchDir,
} from './money-file.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'money-file-'));
  path = moneyFilePath(dir);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const write = (data: unknown) =>
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));

const claude = {
  id: 'claude',
  name: 'Claude Max plan',
  amount: 200,
  currency: 'USD',
  every: 'month',
  day: 12,
  since: '2026-08-12',
};

function logger() {
  return { warn: vi.fn<(obj: object, msg: string) => void>() };
}

describe('moneyFilePath', () => {
  it('is money.json in the data folder', () => {
    expect(moneyFilePath('/data/studio')).toBe('/data/studio/money.json');
  });

  it('has the last good copy next to it', () => {
    expect(MONEY_LAST_GOOD_FILE_NAME).toBe('money.last-good.json');
    expect(moneyLastGoodPath('/data/studio')).toBe('/data/studio/money.last-good.json');
  });
});

describe('readMoneyFile', () => {
  it('gives the defaults for a missing file', () => {
    expect(readMoneyFile(path)).toEqual({ status: 'missing', money: DEFAULT_MONEY });
    expect(DEFAULT_MONEY.pricePerJob).toBe(200);
  });

  it('reads a valid file and fills in the defaults', () => {
    write({ pricePerJob: 250, subscriptions: [claude] });
    const read = readMoneyFile(path);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.money.pricePerJob).toBe(250);
    expect(read.money.usdToIls).toBe(3.7);
    expect(read.money.subscriptions).toHaveLength(1);
    expect(read.money.charges).toEqual([]);
  });

  it('reads an empty object as the defaults', () => {
    write('{}');
    expect(readMoneyFile(path)).toEqual({ status: 'ok', money: DEFAULT_MONEY });
  });

  it('ignores a byte order mark', () => {
    write(`﻿${JSON.stringify({ pricePerJob: 300 })}`);
    expect(readMoneyFile(path).status).toBe('ok');
  });

  it('says where in the file a value is wrong', () => {
    write({ subscriptions: [claude, { ...claude, id: 'eleven', day: 40 }] });
    const read = readMoneyFile(path);
    expect(read.status).toBe('invalid');
    if (read.status !== 'invalid') return;
    expect(read.issues).toHaveLength(1);
    expect(read.issues[0]).toMatch(/^subscriptions\[1\]\.day: /);
  });

  it('lists every problem', () => {
    write({
      usdToIls: -1,
      charges: [{ date: '2026-02-30', item: 'a', what: 'b', amount: 1, currency: 'ILS' }],
    });
    const read = readMoneyFile(path);
    if (read.status !== 'invalid') throw new Error('expected invalid');
    expect(read.issues.map((issue) => issue.split(':')[0])).toEqual([
      'usdToIls',
      'charges[0].date',
    ]);
  });

  it('refuses an unknown key and names it', () => {
    write({ pricePerjob: 200 });
    const read = readMoneyFile(path);
    if (read.status !== 'invalid') throw new Error('expected invalid');
    expect(read.issues[0]).toContain('pricePerjob');
  });

  it('is invalid when the file is not JSON', () => {
    write('{ "pricePerJob": 200,, }');
    const read = readMoneyFile(path);
    if (read.status !== 'invalid') throw new Error('expected invalid');
    expect(read.issues[0]).toMatch(/^cannot be read as JSON/);
  });

  it('is invalid when the file is empty', () => {
    write('');
    expect(readMoneyFile(path).status).toBe('invalid');
  });

  it('is invalid when the top level is not an object', () => {
    write('[]');
    expect(readMoneyFile(path).status).toBe('invalid');
    write('null');
    expect(readMoneyFile(path).status).toBe('invalid');
  });

  it('is invalid, not missing, when the path is not a readable file', () => {
    mkdirSync(path);
    const read = readMoneyFile(path);
    if (read.status !== 'invalid') throw new Error('expected invalid');
    expect(read.issues[0]).toMatch(/^cannot be read/);
  });
});

describe('the README example', () => {
  const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('\n## Money\n'));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)\n\s*```/g)].map(
    (match) => match[1] ?? '',
  );

  it('is a valid money.json with the subscriptions and charge it describes', () => {
    write(blocks[0] ?? '');
    const read = readMoneyFile(path);
    if (read.status !== 'ok') throw new Error(`README example: ${JSON.stringify(read)}`);
    expect(read.money.subscriptions.map((s) => [s.id, s.currency, s.day])).toEqual([
      ['claude', 'USD', 12],
      ['elevenlabs', 'USD', 3],
      ['music', 'ILS', 1],
    ]);
    expect(read.money.subscriptions[2]?.amount).toBe(49);
    expect(read.money.charges).toHaveLength(1);
    expect(read.money.charges[0]?.job).toBe('Lumen Yoga/Retreat teaser');
  });

  it('has a yearly subscription that is valid too', () => {
    write({ subscriptions: [JSON.parse(blocks[1] ?? 'null')] });
    expect(readMoneyFile(path).status).toBe('ok');
  });
});

describe('MoneyFileLoader: loading', () => {
  it('gives the defaults when the file is missing, and logs nothing', () => {
    const log = logger();
    const loader = new MoneyFileLoader({ path, logger: log });
    expect(loader.get()).toEqual(DEFAULT_MONEY);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('loads the file it finds', () => {
    write({ pricePerJob: 250 });
    expect(new MoneyFileLoader({ path }).get().pricePerJob).toBe(250);
  });

  it('logs an invalid file with the path of each problem, and uses the defaults on a first load', () => {
    write({ subscriptions: [{ ...claude, day: 40 }] });
    const log = logger();
    const loader = new MoneyFileLoader({ path, logger: log });
    expect(loader.get()).toEqual(DEFAULT_MONEY);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields] = log.warn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ path });
    expect((fields as { issues: string[] }).issues[0]).toMatch(/^subscriptions\[0\]\.day: /);
  });

  it('picks up the fix after an invalid file', () => {
    write({ pricePerJob: 'free' });
    const loader = new MoneyFileLoader({ path, logger: logger() });
    expect(loader.get().pricePerJob).toBe(200);
    write({ pricePerJob: 275 });
    expect(loader.reload()).toBe(true);
    expect(loader.get().pricePerJob).toBe(275);
  });

  it('keeps the last good value when the file turns invalid', () => {
    write({ pricePerJob: 250 });
    const log = logger();
    const loader = new MoneyFileLoader({ path, logger: log });
    write('{ broken');
    // The numbers stay, but the file's state changed (the Money page's warning line), so it counts.
    expect(loader.reload()).toBe(true);
    expect(loader.get().pricePerJob).toBe(250);
    expect(log.warn).toHaveBeenCalledTimes(1);
    // The same mistake again shows nothing new.
    expect(loader.reload()).toBe(false);
  });

  it('reports no change when the file says the same thing', () => {
    write({ pricePerJob: 250 });
    const loader = new MoneyFileLoader({ path });
    write(JSON.stringify({ pricePerJob: 250 }, null, 2));
    expect(loader.reload()).toBe(false);
  });

  it('goes back to the defaults when the file is removed', () => {
    write({ pricePerJob: 250 });
    const loader = new MoneyFileLoader({ path });
    rmSync(path);
    expect(loader.reload()).toBe(true);
    expect(loader.get()).toEqual(DEFAULT_MONEY);
  });

  it('keeps one object between reloads that change nothing', () => {
    write({ pricePerJob: 250 });
    const loader = new MoneyFileLoader({ path });
    const before = loader.get();
    loader.reload();
    expect(loader.get()).toBe(before);
  });
});

describe('MoneyFileLoader: the last good copy', () => {
  const copyPath = () => moneyLastGoodPath(dir);
  const warnings = (log: ReturnType<typeof logger>) =>
    log.warn.mock.calls.map(([fields, message]) => ({ fields, message }));

  it('saves a copy of every valid file it reads, that reads back as the same value', () => {
    write({ pricePerJob: 40, subscriptions: [claude] });
    const loader = new MoneyFileLoader({ path });

    const copy = readMoneyFile(copyPath());
    expect(copy).toEqual({ status: 'ok', money: loader.get() });
    expect(loader.hasGoodValues()).toBe(true);
    // Only the two files: no temp file is left behind.
    expect(readdirSync(dir).sort()).toEqual(['money.json', 'money.last-good.json']);
  });

  it('replaces the copy when the file changes', () => {
    write({ pricePerJob: 40 });
    const loader = new MoneyFileLoader({ path });
    write({ pricePerJob: 55 });
    loader.reload();

    expect(readMoneyFile(copyPath())).toMatchObject({ status: 'ok', money: { pricePerJob: 55 } });
    expect(readdirSync(dir).sort()).toEqual(['money.json', 'money.last-good.json']);
  });

  it('keeps the copy as it was when the file turns invalid', () => {
    write({ pricePerJob: 40 });
    const loader = new MoneyFileLoader({ path, logger: logger() });
    const before = readFileSync(copyPath(), 'utf8');
    write('{ broken');
    loader.reload();

    expect(readFileSync(copyPath(), 'utf8')).toBe(before);
  });

  it('writes no copy for a missing file, and the defaults count as good', () => {
    const loader = new MoneyFileLoader({ path });
    expect(existsSync(copyPath())).toBe(false);
    expect(loader.hasGoodValues()).toBe(true);
  });

  it('saves a copy of a valid file that is just the defaults, replacing an older one', () => {
    write({ pricePerJob: 40 });
    new MoneyFileLoader({ path });
    write('{}');
    new MoneyFileLoader({ path });

    expect(readMoneyFile(copyPath())).toEqual({ status: 'ok', money: DEFAULT_MONEY });
  });

  it('starts from the copy when a restart finds the file invalid, and says so', () => {
    write({ pricePerJob: 40, subscriptions: [claude] });
    const first = new MoneyFileLoader({ path });
    write({ subscriptions: [{ ...claude, day: 40 }] });
    const log = logger();

    const restarted = new MoneyFileLoader({ path, logger: log });

    expect(restarted.get()).toEqual(first.get());
    expect(restarted.get().pricePerJob).toBe(40);
    expect(restarted.hasGoodValues()).toBe(true);
    expect(warnings(log)).toEqual([
      {
        fields: { path, issues: [expect.stringMatching(/^subscriptions\[0\]\.day: /)] },
        message: 'money.json is invalid; keeping the last good values (from money.last-good.json)',
      },
    ]);
  });

  it('uses the copy for a file that is not JSON or is empty, too', () => {
    write({ pricePerJob: 40 });
    new MoneyFileLoader({ path });
    for (const text of ['{ "pricePerJob": ', '']) {
      write(text);
      expect(new MoneyFileLoader({ path, logger: logger() }).get().pricePerJob).toBe(40);
    }
  });

  it('keeps using the copy through further invalid saves, then follows the fix', () => {
    write({ pricePerJob: 40 });
    new MoneyFileLoader({ path });
    write('{ broken');
    const log = logger();
    const loader = new MoneyFileLoader({ path, logger: log });

    expect(loader.reload()).toBe(false);
    expect(loader.get().pricePerJob).toBe(40);

    write({ pricePerJob: 60 });
    expect(loader.reload()).toBe(true);
    expect(loader.get().pricePerJob).toBe(60);
    expect(readMoneyFile(copyPath())).toMatchObject({ money: { pricePerJob: 60 } });
    expect(warnings(log).map((w) => w.message)).toEqual([
      'money.json is invalid; keeping the last good values (from money.last-good.json)',
      'money.json is invalid; keeping the last good values',
    ]);
  });

  it('uses the defaults, and says there is no good version, when there is no copy', () => {
    write({ pricePerJob: 'free' });
    const log = logger();

    const loader = new MoneyFileLoader({ path, logger: log });

    expect(loader.get()).toEqual(DEFAULT_MONEY);
    expect(loader.hasGoodValues()).toBe(false);
    expect(warnings(log)).toEqual([
      {
        fields: { path, issues: [expect.stringMatching(/^pricePerJob: /)] },
        message: 'money.json is invalid; using defaults (no good version saved)',
      },
    ]);
  });

  it('does not trust a copy that is not valid either', () => {
    write({ pricePerJob: 40 });
    new MoneyFileLoader({ path });
    writeFileSync(copyPath(), '{ "pricePerJob": ');
    write('{ broken');
    const log = logger();

    const loader = new MoneyFileLoader({ path, logger: log });

    expect(loader.get()).toEqual(DEFAULT_MONEY);
    expect(loader.hasGoodValues()).toBe(false);
    const [first] = warnings(log);
    expect(first?.message).toBe('money.json is invalid; using defaults (no good version saved)');
    expect(first?.fields).toHaveProperty('copyIssues');
  });

  it('has good values again once the file is fixed, and saves the first copy', () => {
    write({ pricePerJob: 'free' });
    const loader = new MoneyFileLoader({ path, logger: logger() });
    expect(loader.hasGoodValues()).toBe(false);

    write({ pricePerJob: 70 });
    expect(loader.reload()).toBe(true);

    expect(loader.hasGoodValues()).toBe(true);
    expect(readMoneyFile(copyPath())).toMatchObject({ money: { pricePerJob: 70 } });
  });

  it('counts a removed file as good: the defaults are valid', () => {
    write({ pricePerJob: 'free' });
    const loader = new MoneyFileLoader({ path, logger: logger() });
    rmSync(path);

    loader.reload();

    expect(loader.hasGoodValues()).toBe(true);
  });

  it('stays good, from memory, when a file that was valid turns invalid while running', () => {
    write({ pricePerJob: 40 });
    const log = logger();
    const loader = new MoneyFileLoader({ path, logger: log });
    rmSync(copyPath());
    write('{ broken');

    expect(loader.reload()).toBe(true);

    expect(loader.hasGoodValues()).toBe(true);
    expect(loader.get().pricePerJob).toBe(40);
    expect(warnings(log).map((w) => w.message)).toEqual([
      'money.json is invalid; keeping the last good values',
    ]);
  });

  it('carries on, and says so, when the copy cannot be saved', () => {
    write({ pricePerJob: 40 });
    const log = logger();
    const lastGoodPath = join(dir, 'no-such-folder', MONEY_LAST_GOOD_FILE_NAME);

    const loader = new MoneyFileLoader({ path, lastGoodPath, logger: log });

    expect(loader.get().pricePerJob).toBe(40);
    expect(loader.hasGoodValues()).toBe(true);
    expect(warnings(log)).toEqual([
      {
        fields: { path: lastGoodPath, error: expect.any(String) },
        message: 'cannot save the last good copy of money.json',
      },
    ]);
    expect(readdirSync(dir)).toEqual(['money.json']);
  });

  it('keeps the copy where it is told to', () => {
    write({ pricePerJob: 40 });
    const lastGoodPath = join(dir, 'elsewhere.json');
    new MoneyFileLoader({ path, lastGoodPath });
    write('{ broken');

    const restarted = new MoneyFileLoader({ path, lastGoodPath, logger: logger() });

    expect(restarted.get().pricePerJob).toBe(40);
    expect(existsSync(copyPath())).toBe(false);
  });
});

describe('MoneyFileLoader: fileState', () => {
  const copyPath = () => moneyLastGoodPath(dir);
  const OK = { status: 'ok', issue: null };

  it('is ok for a valid file, and for a missing one: the defaults are right then', () => {
    expect(new MoneyFileLoader({ path }).fileState()).toEqual(OK);
    write({ pricePerJob: 250 });
    expect(new MoneyFileLoader({ path }).fileState()).toEqual(OK);
  });

  it('is last-good, with the first problem, when a restart finds the file invalid and a copy exists', () => {
    write({ pricePerJob: 40 });
    new MoneyFileLoader({ path });
    const charge = {
      date: '2026-10-14',
      item: 'Stock footage',
      what: 'Clip',
      amount: 7.5,
      currency: 'ILS',
    };
    write({ charges: [charge, charge, { ...charge, date: '2026-13-40' }] });

    const state = new MoneyFileLoader({ path, logger: logger() }).fileState();

    expect(state).toEqual({
      status: 'last-good',
      issue: 'charges[2].date: must be a date written YYYY-MM-DD, like 2026-10-14',
    });
  });

  it('is defaults, with the first problem, when the file is invalid and there is no good version', () => {
    write({ subscriptions: [{ ...claude, day: 40 }] });

    const loader = new MoneyFileLoader({ path, logger: logger() });

    expect(loader.fileState()).toEqual({
      status: 'defaults',
      issue: expect.stringMatching(/^subscriptions\[0\]\.day: /),
    });
    expect(loader.hasGoodValues()).toBe(false);
  });

  it('is defaults, too, when the copy is not valid either', () => {
    write({ pricePerJob: 40 });
    new MoneyFileLoader({ path });
    writeFileSync(copyPath(), '{ "pricePerJob": ');
    write('{ broken');

    expect(new MoneyFileLoader({ path, logger: logger() }).fileState().status).toBe('defaults');
  });

  it('is last-good when a file that was valid turns invalid while running, and ok again once fixed', () => {
    write({ pricePerJob: 40 });
    const loader = new MoneyFileLoader({ path, logger: logger() });

    write('{ broken');
    loader.reload();
    expect(loader.fileState().status).toBe('last-good');

    write({ pricePerJob: 40 });
    expect(loader.reload()).toBe(true);
    expect(loader.fileState()).toEqual(OK);
  });

  it('goes from defaults to ok when the file is fixed, and to ok when it is removed', () => {
    write({ pricePerJob: 'free' });
    const loader = new MoneyFileLoader({ path, logger: logger() });
    expect(loader.fileState().status).toBe('defaults');
    write({ pricePerJob: 70 });
    loader.reload();
    expect(loader.fileState()).toEqual(OK);

    write('{ broken');
    loader.reload();
    expect(loader.fileState().status).toBe('last-good');
    rmSync(path);
    expect(loader.reload()).toBe(true);
    expect(loader.fileState()).toEqual(OK);
  });

  it('follows the first problem when the mistake changes, and reports that as a change', () => {
    write({ pricePerJob: 40 });
    const loader = new MoneyFileLoader({ path, logger: logger() });

    write({ pricePerJob: 'free' });
    expect(loader.reload()).toBe(true);
    const first = loader.fileState();
    expect(first.issue).toMatch(/^pricePerJob: /);

    write({ usdToIls: 'high' });
    expect(loader.reload()).toBe(true);
    expect(loader.fileState().issue).toMatch(/^usdToIls: /);

    // The state object stays the same one while nothing changes.
    const before = loader.fileState();
    expect(loader.reload()).toBe(false);
    expect(loader.fileState()).toBe(before);
  });

  it('says a file that is not JSON in one line', () => {
    write('{\n  "pricePerJob": \n');
    const state = new MoneyFileLoader({ path, logger: logger() }).fileState();

    expect(state.status).toBe('defaults');
    expect(state.issue).toMatch(/^cannot be read as JSON/);
    expect(state.issue).not.toMatch(/\n/);
  });

  it('cuts a very long problem to one short line', () => {
    write({ subscriptions: [{ ...claude, id: 'x'.repeat(500), currency: 'y'.repeat(500) }] });
    const state = new MoneyFileLoader({ path, logger: logger() }).fileState();

    expect(state.status).toBe('defaults');
    expect((state.issue ?? '').length).toBeLessThanOrEqual(200);
  });
});

/** A folder watcher driven by hand, so fake timers and file events don't fight each other. */
function fakeWatchDir() {
  const watchers: (EventEmitter & DirWatcher & { dir: string; closed: boolean })[] = [];
  const listeners: ((event: string, filename: string | null) => void)[] = [];
  const watchDir: WatchDir = (watchedDir, listener) => {
    const watcher = Object.assign(new EventEmitter(), {
      dir: watchedDir,
      closed: false,
      close() {
        watcher.closed = true;
      },
    });
    watchers.push(watcher);
    listeners.push(listener);
    return watcher;
  };
  return {
    watchDir,
    watchers,
    emit: (filename: string | null, event = 'change') => {
      for (const listener of listeners) listener(event, filename);
    },
  };
}

describe('MoneyFileLoader: watch with a fake folder watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('watches the data folder, not the file', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    loader.watch(() => {});
    expect(fake.watchers).toHaveLength(1);
    expect(fake.watchers[0]?.dir).toBe(dir);
  });

  it('waits 300 ms after the last event, then reads once', () => {
    expect(MONEY_WATCH_DEBOUNCE_MS).toBe(300);
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const onChange = vi.fn<(money: MoneyFile) => void>();
    loader.watch(onChange);

    write({ pricePerJob: 250 });
    fake.emit('money.json');
    vi.advanceTimersByTime(200);
    fake.emit('money.json', 'rename');
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].pricePerJob).toBe(250);
    expect(loader.get().pricePerJob).toBe(250);
  });

  it('ignores other files in the folder', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const onChange = vi.fn();
    loader.watch(onChange);
    write({ pricePerJob: 250 });
    fake.emit('engine.db');
    fake.emit('.money.json.swp');
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(loader.get().pricePerJob).toBe(200);
  });

  it('reads when the platform does not say which file changed', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const onChange = vi.fn();
    loader.watch(onChange);
    write({ pricePerJob: 250 });
    fake.emit(null);
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('sees a file created after the watch began', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const onChange = vi.fn();
    loader.watch(onChange);
    expect(loader.get()).toEqual(DEFAULT_MONEY);
    write({ subscriptions: [claude] });
    fake.emit('money.json', 'rename');
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(loader.get().subscriptions).toHaveLength(1);
  });

  it('calls back when the file turns invalid, with the numbers it keeps, and once it is fixed', () => {
    write({ pricePerJob: 250 });
    const log = logger();
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, logger: log, watchDir: fake.watchDir });
    const onChange = vi.fn<(money: MoneyFile) => void>();
    loader.watch(onChange);

    write('{ "pricePerJob": ');
    fake.emit('money.json');
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].pricePerJob).toBe(250);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(loader.get().pricePerJob).toBe(250);
    expect(loader.fileState().status).toBe('last-good');

    // Saving the same mistake again changes nothing on the page.
    fake.emit('money.json');
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);

    write({ pricePerJob: 260 });
    fake.emit('money.json');
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]?.[0].pricePerJob).toBe(260);
    expect(loader.fileState()).toEqual({ status: 'ok', issue: null });
  });

  it('does not call back when the change leaves the value as it was', () => {
    write({ pricePerJob: 250 });
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const onChange = vi.fn();
    loader.watch(onChange);
    write(JSON.stringify({ pricePerJob: 250 }, null, 4));
    fake.emit('money.json');
    vi.advanceTimersByTime(300);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls every subscriber, and a throwing one does not stop the others', () => {
    const log = logger();
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, logger: log, watchDir: fake.watchDir });
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    loader.watch(bad);
    loader.watch(good);
    expect(fake.watchers).toHaveLength(1);
    write({ pricePerJob: 250 });
    fake.emit('money.json');
    vi.advanceTimersByTime(300);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('stops one subscriber, and the watcher when the last one stops', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = loader.watch(first);
    const stopSecond = loader.watch(second);

    stopFirst();
    expect(fake.watchers[0]?.closed).toBe(false);
    write({ pricePerJob: 250 });
    fake.emit('money.json');
    vi.advanceTimersByTime(300);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    stopSecond();
    expect(fake.watchers[0]?.closed).toBe(true);
  });

  it('drops a read that was waiting when the last subscriber stops', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const onChange = vi.fn();
    const stop = loader.watch(onChange);
    write({ pricePerJob: 250 });
    fake.emit('money.json');
    stop();
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a new watcher when watching again after it stopped', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    loader.watch(() => {})();
    loader.watch(() => {});
    expect(fake.watchers).toHaveLength(2);
    expect(fake.watchers[0]?.closed).toBe(true);
    expect(fake.watchers[1]?.closed).toBe(false);
  });

  it('closes the watcher and forgets the subscribers on close', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, watchDir: fake.watchDir });
    const onChange = vi.fn();
    loader.watch(onChange);
    loader.close();
    expect(fake.watchers[0]?.closed).toBe(true);
    write({ pricePerJob: 250 });
    fake.emit('money.json');
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('logs and carries on when the folder cannot be watched', () => {
    const log = logger();
    const loader = new MoneyFileLoader({
      path,
      logger: log,
      watchDir: () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });
    expect(() => loader.watch(() => {})).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(loader.get()).toEqual(DEFAULT_MONEY);
  });

  it('logs a watcher error instead of throwing, and lets go of the watcher', () => {
    const log = logger();
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, logger: log, watchDir: fake.watchDir });
    loader.watch(() => {});
    expect(() => fake.watchers[0]?.emit('error', new Error('EPERM'))).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(fake.watchers[0]?.closed).toBe(true);
  });

  it('uses the debounce it is given', () => {
    const fake = fakeWatchDir();
    const loader = new MoneyFileLoader({ path, debounceMs: 50, watchDir: fake.watchDir });
    const onChange = vi.fn();
    loader.watch(onChange);
    write({ pricePerJob: 250 });
    fake.emit('money.json');
    vi.advanceTimersByTime(50);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('MoneyFileLoader: watch with the real file system', () => {
  let loader: MoneyFileLoader | undefined;

  afterEach(() => {
    loader?.close();
    loader = undefined;
  });

  /** Waits for the next call of `onChange` and gives its value. */
  async function nextChange(
    onChange: ReturnType<typeof vi.fn<(money: MoneyFile) => void>>,
    callsBefore: number,
  ): Promise<MoneyFile> {
    await vi.waitFor(() => expect(onChange.mock.calls.length).toBeGreaterThan(callsBefore), {
      timeout: 5_000,
      interval: 20,
    });
    const money = onChange.mock.calls[callsBefore]?.[0];
    if (!money) throw new Error('no change');
    return money;
  }

  it('sees the file created later, edited in place, replaced by a rename, and removed', async () => {
    loader = new MoneyFileLoader({ path, debounceMs: 30 });
    const onChange = vi.fn<(money: MoneyFile) => void>();
    loader.watch(onChange);
    // fs.watch needs a moment before it reports changes on some systems.
    await new Promise((resolve) => setTimeout(resolve, 100));

    write({ pricePerJob: 250 });
    expect((await nextChange(onChange, 0)).pricePerJob).toBe(250);

    write({ pricePerJob: 260 });
    expect((await nextChange(onChange, 1)).pricePerJob).toBe(260);

    // An editor's safe save: write a neighbour, then rename it over the file.
    writeFileSync(join(dir, 'money.json.tmp'), JSON.stringify({ pricePerJob: 270 }));
    renameSync(join(dir, 'money.json.tmp'), path);
    expect((await nextChange(onChange, 2)).pricePerJob).toBe(270);

    rmSync(path);
    expect((await nextChange(onChange, 3)).pricePerJob).toBe(200);
    expect(loader.get()).toEqual(DEFAULT_MONEY);
  });

  it('calls back for a broken save, keeps the last good value, and fixes itself on the next', async () => {
    write({ pricePerJob: 250 });
    const log = logger();
    loader = new MoneyFileLoader({ path, logger: log, debounceMs: 30 });
    const onChange = vi.fn<(money: MoneyFile) => void>();
    loader.watch(onChange);
    await new Promise((resolve) => setTimeout(resolve, 100));

    write('{ "pricePerJob": ');
    expect((await nextChange(onChange, 0)).pricePerJob).toBe(250);
    expect(log.warn).toHaveBeenCalled();
    expect(loader.get().pricePerJob).toBe(250);
    expect(loader.fileState().status).toBe('last-good');

    write({ pricePerJob: 300 });
    expect((await nextChange(onChange, 1)).pricePerJob).toBe(300);
    expect(loader.fileState()).toEqual({ status: 'ok', issue: null });
  });
});
