import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLimits,
  backfillLimits,
  limitsLogPath,
  parseLimitsLog,
  readLimits,
  snapshotOf,
} from './limits-log.js';

let root: string;
let dataDir: string;
let logsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-limits-'));
  dataDir = join(root, 'data');
  logsDir = join(dataDir, 'logs');
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The reading the CLI writes (fixtures/stream/sample-run.jsonl), times in epoch seconds.
const FIVE_HOUR_RESET = 1792614000; // 2026-10-21T20:20:00Z
const SEVEN_DAY_RESET = 1792864800; // 2026-10-24T18:00:00Z

function info(
  fiveHour: number,
  sevenDay: number,
  status = 'allowed',
  extra: Record<string, unknown> = {},
) {
  return {
    status,
    resetsAt: FIVE_HOUR_RESET,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: FIVE_HOUR_RESET },
      seven_day: { utilization: sevenDay, resetsAt: SEVEN_DAY_RESET },
    },
    ...extra,
  };
}

const at = (iso: string) => new Date(iso);
const lines = () => readFileSync(limitsLogPath(dataDir), 'utf8').trimEnd().split('\n');

describe('snapshotOf', () => {
  it('reads both windows, with the reset times as ISO timestamps', () => {
    expect(snapshotOf(info(0.4, 0.17), at('2026-10-21T12:00:00Z'))).toEqual({
      at: '2026-10-21T12:00:00.000Z',
      status: 'allowed',
      fiveHour: { utilization: 0.4, resetsAt: '2026-10-21T20:20:00.000Z' },
      sevenDay: { utilization: 0.17, resetsAt: '2026-10-24T18:00:00.000Z' },
    });
  });

  it('leaves out a window the reading does not carry', () => {
    const { unifiedWindows, ...rest } = info(0.4, 0.17);
    const onlyFive = { ...rest, unifiedWindows: { five_hour: unifiedWindows.five_hour } };

    expect(snapshotOf(onlyFive, at('2026-10-21T12:00:00Z'))).toMatchObject({
      fiveHour: { utilization: 0.4 },
      sevenDay: null,
    });
    expect(snapshotOf({ status: 'allowed' }, at('2026-10-21T12:00:00Z'))).toMatchObject({
      fiveHour: null,
      sevenDay: null,
    });
  });

  it('takes the weekly window from the event itself when the event is about it', () => {
    const refused = {
      status: 'rejected',
      resetsAt: SEVEN_DAY_RESET,
      rateLimitType: 'seven_day',
    };

    expect(snapshotOf(refused, at('2026-10-21T12:00:00Z'))).toMatchObject({
      status: 'rejected',
      fiveHour: null,
      sevenDay: { utilization: 1, resetsAt: '2026-10-24T18:00:00.000Z' },
    });
    expect(
      snapshotOf(
        { ...refused, status: 'allowed_warning', utilization: 0.93 },
        at('2026-10-21T12:00:00Z'),
      ),
    ).toMatchObject({ sevenDay: { utilization: 0.93 } });
  });

  it('is nothing for what is not a reading', () => {
    for (const value of [undefined, null, 'allowed', [], {}, { status: '' }, { status: 4 }]) {
      expect(snapshotOf(value, at('2026-10-21T12:00:00Z'))).toBeNull();
    }
  });

  it('ignores a window with a bad number', () => {
    const odd = {
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: -1, resetsAt: FIVE_HOUR_RESET },
        seven_day: { utilization: 0.2, resetsAt: 'tomorrow' },
      },
    };

    expect(snapshotOf(odd, at('2026-10-21T12:00:00Z'))).toMatchObject({
      fiveHour: null,
      sevenDay: null,
    });
  });
});

describe('appendLimits', () => {
  it('writes one JSON line per reading, in order, and readLimits gives them back', async () => {
    expect(await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:00:00Z'))).toBe(true);
    expect(await appendLimits(dataDir, info(0.3, 0.12), at('2026-10-21T10:05:00Z'))).toBe(true);

    expect(lines()).toHaveLength(2);
    expect(await readLimits(dataDir)).toEqual([
      expect.objectContaining({ at: '2026-10-21T10:00:00.000Z', fiveHour: expect.anything() }),
      expect.objectContaining({ at: '2026-10-21T10:05:00.000Z' }),
    ]);
    const second = JSON.parse(lines()[1] ?? '');
    expect(second).toEqual({
      at: '2026-10-21T10:05:00.000Z',
      status: 'allowed',
      fiveHour: { utilization: 0.3, resetsAt: '2026-10-21T20:20:00.000Z' },
      sevenDay: { utilization: 0.12, resetsAt: '2026-10-24T18:00:00.000Z' },
    });
  });

  it('writes only when the reading differs from the last line', async () => {
    const written = [];
    for (const [utilization, minute] of [
      [0.2, 0],
      [0.2, 1], // the same, a minute later
      [0.21, 2],
      [0.21, 3],
      [0.2, 4], // back to an earlier value: it differs from the LAST line
    ] as const) {
      written.push(
        await appendLimits(dataDir, info(utilization, 0.12), at(`2026-10-21T10:0${minute}:00Z`)),
      );
    }

    expect(written).toEqual([true, false, true, false, true]);
    expect(lines()).toHaveLength(3);
  });

  it('counts a change of the status, the weekly window or its reset as a difference', async () => {
    await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:00:00Z'));

    expect(await appendLimits(dataDir, info(0.2, 0.13), at('2026-10-21T10:01:00Z'))).toBe(true);
    expect(
      await appendLimits(dataDir, info(0.2, 0.13, 'rejected'), at('2026-10-21T10:02:00Z')),
    ).toBe(true);
    const next = info(0.2, 0.13, 'rejected');
    next.unifiedWindows.seven_day.resetsAt = SEVEN_DAY_RESET + 7 * 86_400;
    expect(await appendLimits(dataDir, next, at('2026-10-21T10:03:00Z'))).toBe(true);
    expect(lines()).toHaveLength(4);
  });

  it('compares with the file, not with what it remembers: a log written before is carried on', async () => {
    await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:00:00Z'));
    writeFileSync(
      limitsLogPath(dataDir),
      `${readFileSync(limitsLogPath(dataDir), 'utf8')}${JSON.stringify(snapshotOf(info(0.5, 0.2), at('2026-10-21T11:00:00Z')))}\n`,
    );

    expect(await appendLimits(dataDir, info(0.5, 0.2), at('2026-10-21T12:00:00Z'))).toBe(false);
    expect(await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T12:00:00Z'))).toBe(true);
  });

  it('also writes an unchanged reading when the last line is older than refreshAfterMs (the plan probe)', async () => {
    const tenMinutes = 10 * 60_000;
    await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:00:00Z'), {
      refreshAfterMs: tenMinutes,
    });
    // Nine minutes on: still the same line.
    expect(
      await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:09:00Z'), {
        refreshAfterMs: tenMinutes,
      }),
    ).toBe(false);
    // Eleven minutes on: the same reading, written again so "last read" moves on.
    expect(
      await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:11:00Z'), {
        refreshAfterMs: tenMinutes,
      }),
    ).toBe(true);
    expect((await readLimits(dataDir)).map((s) => s.at)).toEqual([
      '2026-10-21T10:00:00.000Z',
      '2026-10-21T10:11:00.000Z',
    ]);
    // Without the option, as the runs call it, an unchanged reading is still not written.
    expect(await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T13:00:00Z'))).toBe(false);
  });

  it('keeps the order and the count when runs append at the same time', async () => {
    const results = await Promise.all(
      [0.1, 0.1, 0.2, 0.2, 0.3, 0.3].map((utilization, i) =>
        appendLimits(dataDir, info(utilization, 0.12), at(`2026-10-21T10:0${i}:00Z`)),
      ),
    );

    expect(results).toEqual([true, false, true, false, true, false]);
    expect((await readLimits(dataDir)).map((s) => s.fiveHour?.utilization)).toEqual([
      0.1, 0.2, 0.3,
    ]);
  });

  it('starts a new line after one that was cut off in the middle', async () => {
    writeFileSync(limitsLogPath(dataDir), '{"at":"2026-10-21T09:00:00.000Z","stat');

    expect(await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:00:00Z'))).toBe(true);

    expect(await readLimits(dataDir)).toHaveLength(1);
  });

  it('does not write what is not a reading', async () => {
    expect(await appendLimits(dataDir, undefined, at('2026-10-21T10:00:00Z'))).toBe(false);
    expect(await appendLimits(dataDir, { status: '' }, at('2026-10-21T10:00:00Z'))).toBe(false);

    expect(await readLimits(dataDir)).toEqual([]);
  });

  it('never throws: a folder that is not there, or a path that is a file, writes nothing', async () => {
    const missing = join(root, 'not-there');
    writeFileSync(join(root, 'a-file'), 'x');

    expect(await appendLimits(missing, info(0.2, 0.12), at('2026-10-21T10:00:00Z'))).toBe(false);
    expect(
      await appendLimits(join(root, 'a-file'), info(0.2, 0.12), at('2026-10-21T10:00:00Z')),
    ).toBe(false);
    // And the ones after it still work.
    expect(await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:00:00Z'))).toBe(true);
  });
});

describe('readLimits', () => {
  it('is empty without a log', async () => {
    expect(await readLimits(dataDir)).toEqual([]);
  });

  it('skips lines it cannot read', async () => {
    const good = JSON.stringify(snapshotOf(info(0.2, 0.12), at('2026-10-21T10:00:00Z')));
    writeFileSync(
      limitsLogPath(dataDir),
      [
        '',
        'not json',
        '{"at":"2026-10-21T10:00:00.000Z"}',
        '{"at":"yesterday","status":"allowed","fiveHour":null,"sevenDay":null}',
        good,
        '[1,2]',
      ].join('\n'),
    );

    expect(await readLimits(dataDir)).toHaveLength(1);
    expect(parseLimitsLog(`${good}\n${good}\n`)).toHaveLength(2);
  });
});

describe('backfillLimits', () => {
  const event = (fiveHour: number, sevenDay: number) =>
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info(fiveHour, sevenDay) });

  /** A run log: a start marker, stream lines and an end marker. */
  function writeLog(path: string, mtime: string, body: string[]): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      [
        '{"type":"studio_engine","event":"start","prompt":"mentions rate_limit_event"}',
        ...body,
        '{"type":"studio_engine","event":"end"}',
      ].join('\n'),
    );
    utimesSync(path, new Date(mtime), new Date(mtime));
  }

  it('writes the file from the job and client logs, oldest log first, with the log time', async () => {
    writeLog(join(logsDir, 'jobs', 'b.log'), '2026-10-21T16:00:00Z', [
      '{"type":"assistant"}',
      event(0.3, 0.15),
      event(0.31, 0.15),
    ]);
    writeLog(join(logsDir, 'clients', 'c.log'), '2026-10-21T18:00:00Z', [event(0.4, 0.17)]);
    writeLog(join(logsDir, 'jobs', 'a.log'), '2026-10-20T09:00:00Z', [event(0.1, 0.1)]);
    writeFileSync(join(logsDir, 'jobs', 'notes.txt'), event(0.9, 0.9));

    expect(await backfillLimits({ dataDir, logsDir })).toBe(4);

    expect(
      (await readLimits(dataDir)).map((s) => [
        s.at,
        s.fiveHour?.utilization,
        s.sevenDay?.utilization,
      ]),
    ).toEqual([
      ['2026-10-20T09:00:00.000Z', 0.1, 0.1],
      ['2026-10-21T16:00:00.000Z', 0.3, 0.15],
      ['2026-10-21T16:00:00.000Z', 0.31, 0.15],
      ['2026-10-21T18:00:00.000Z', 0.4, 0.17],
    ]);
  });

  it('writes a line only when the reading changes, across the logs', async () => {
    writeLog(join(logsDir, 'jobs', 'a.log'), '2026-10-20T09:00:00Z', [
      event(0.3, 0.15),
      event(0.3, 0.15),
    ]);
    writeLog(join(logsDir, 'jobs', 'b.log'), '2026-10-21T09:00:00Z', [event(0.3, 0.15)]);

    expect(await backfillLimits({ dataDir, logsDir })).toBe(1);
  });

  it('skips lines of a log that are not events, and events with no reading', async () => {
    writeLog(join(logsDir, 'jobs', 'a.log'), '2026-10-20T09:00:00Z', [
      '{"type":"rate_limit_event"',
      '{"type":"assistant","text":"rate_limit_event"}',
      JSON.stringify({ type: 'rate_limit_event' }),
      event(0.3, 0.15),
    ]);

    expect(await backfillLimits({ dataDir, logsDir })).toBe(1);
  });

  it('writes an empty file when there is nothing to find, so the logs are read once', async () => {
    expect(await backfillLimits({ dataDir, logsDir })).toBe(0);

    expect(readFileSync(limitsLogPath(dataDir), 'utf8')).toBe('');
    writeLog(join(logsDir, 'jobs', 'a.log'), '2026-10-20T09:00:00Z', [event(0.3, 0.15)]);
    expect(await backfillLimits({ dataDir, logsDir })).toBeNull();
    expect(readFileSync(limitsLogPath(dataDir), 'utf8')).toBe('');
  });

  it('does nothing when the limits log exists, and leaves it as it is', async () => {
    await appendLimits(dataDir, info(0.2, 0.12), at('2026-10-21T10:00:00Z'));
    const before = readFileSync(limitsLogPath(dataDir), 'utf8');
    writeLog(join(logsDir, 'jobs', 'a.log'), '2026-10-20T09:00:00Z', [event(0.3, 0.15)]);

    expect(await backfillLimits({ dataDir, logsDir })).toBeNull();
    expect(readFileSync(limitsLogPath(dataDir), 'utf8')).toBe(before);
  });

  it('carries on with a data folder that is not made yet', async () => {
    const fresh = join(root, 'fresh');

    expect(await backfillLimits({ dataDir: fresh, logsDir: join(fresh, 'logs') })).toBe(0);
    expect(await readLimits(fresh)).toEqual([]);
  });
});
