import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobLog, jobLogPath, readLastEnd } from './job-log.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-joblog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('JobLog', () => {
  it('lives at <logsDir>/jobs/<id>.log and creates the folder', async () => {
    const path = jobLogPath(join(dir, 'logs'), 'abc123');
    expect(path).toBe(join(dir, 'logs', 'jobs', 'abc123.log'));
    const log = await JobLog.open(path);
    log.line('{"type":"system"}');
    await log.close();
    expect(readFileSync(path, 'utf8')).toBe('{"type":"system"}\n');
  });

  it('appends stream lines verbatim and markers as JSON lines, across runs', async () => {
    const path = jobLogPath(dir, 'j');
    const first = await JobLog.open(path);
    first.marker('start', { mode: 'start' });
    first.line('not json at all');
    first.marker('end', { outcome: 'failed', error: 'boom' });
    await first.close();
    const second = await JobLog.open(path);
    second.marker('start', { mode: 'retry' });
    await second.close();

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('not json at all');
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      type: 'studio_engine',
      event: 'start',
      mode: 'start',
    });
    expect(lines[2]?.startsWith('{"type":"studio_engine","event":"end","at":"')).toBe(true);
  });
});

describe('readLastEnd', () => {
  it('finds the last end marker, skipping broken lines and later runs without one', async () => {
    const path = jobLogPath(dir, 'j');
    const log = await JobLog.open(path);
    log.marker('end', { outcome: 'failed', error: 'first' });
    log.line('{"type":"assistant"}');
    log.marker('end', { outcome: 'timed_out', error: 'second' });
    log.marker('start', { mode: 'resume' }); // a run the engine died in: no end marker
    log.line('{"type":"studio_engine","event":"end","outc'); // cut short
    await log.close();

    expect(await readLastEnd(path)).toMatchObject({ outcome: 'timed_out', error: 'second' });
  });

  it('reads a stopped run (the engine shut down) as its own outcome, not a cancel', async () => {
    const path = jobLogPath(dir, 'j');
    const log = await JobLog.open(path);
    log.marker('end', { outcome: 'cancelled', error: 'Cancelled' });
    log.marker('end', { outcome: 'stopped', error: 'Stopped because the engine shut down' });
    await log.close();

    expect(await readLastEnd(path)).toMatchObject({
      outcome: 'stopped',
      error: 'Stopped because the engine shut down',
    });
  });

  it('is null without a log or without any end marker', async () => {
    expect(await readLastEnd(join(dir, 'missing.log'))).toBeNull();
    writeFileSync(join(dir, 'x.log'), '{"type":"result"}\n');
    expect(await readLastEnd(join(dir, 'x.log'))).toBeNull();
  });
});
