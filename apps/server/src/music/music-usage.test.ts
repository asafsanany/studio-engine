import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MusicRecord } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readUsageLog } from '../usage/usage-log.js';
import { createMusicUsageLogger, versionIsLogged } from './music-usage.js';
import { fixtureRecord } from './test-utils.js';

// One `music` line in the usage log per version ElevenLabs made, once, never for the fake path.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JOB = { id: 'a1b2c3d4e5f6', client: 'Horizon FPV', name: 'Demo' };

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-music-usage-'));
  dirs.push(dataDir);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const log = createMusicUsageLogger({ dataDir, home: dataDir, env: {}, logger });
  const lines = async () => (await readUsageLog(dataDir)).filter((entry) => entry.tag === 'music');
  return { dataDir, logger, log, lines };
}

/** Versions made a minute ago, so the lines logged now come after them. */
function made(ids: string[], model = 'music_v2_5'): MusicRecord {
  const base = fixtureRecord();
  const start = Date.now() - 60_000;
  return {
    ...base,
    picked: ids.at(-1) as 'v1',
    versions: ids.map((id, index) => ({
      ...(base.versions[0] as MusicRecord['versions'][number]),
      id: id as 'v1',
      file: `${id}.mp3`,
      model,
      madeAt: new Date(start + index * 1_000).toISOString(),
    })),
  };
}

describe('createMusicUsageLogger', () => {
  it('logs a line for each version made: tag music, who it was for, no tokens, no session', async () => {
    const { log, lines } = setup();

    await log(JOB, made(['v1', 'v2']));

    const written = await lines();
    expect(written.map((line) => line.did)).toEqual([
      'Made music v1 for Horizon FPV / Demo (0:39)',
      'Made music v2 for Horizon FPV / Demo (0:39)',
    ]);
    expect(written[0]).toMatchObject({
      source: 'app',
      tag: 'music',
      client: 'Horizon FPV',
      job: { id: JOB.id, name: 'Demo' },
      session: null,
      usage: {},
    });
  });

  it('counts a version once: the same record again, or a record with one more version, logs only what is new', async () => {
    const { log, lines } = setup();

    await log(JOB, made(['v1']));
    await log(JOB, made(['v1']));
    await log(JOB, made(['v1', 'v2']));
    await log(JOB, made(['v1', 'v2']));

    expect((await lines()).map((line) => line.did.slice(0, 13))).toEqual([
      'Made music v1',
      'Made music v2',
    ]);
  });

  it('counts a version once even when two callers see it at the same moment', async () => {
    const { log, lines } = setup();
    await Promise.all([log(JOB, made(['v1'])), log(JOB, made(['v1'])), log(JOB, made(['v1']))]);
    expect(await lines()).toHaveLength(1);
  });

  it('never logs a version of the fake path', async () => {
    const { log, lines } = setup();
    await log(JOB, made(['v1', 'v2'], 'fake'));
    expect(await lines()).toEqual([]);
  });

  it('logs the same id again for another job, and for a job made again after it was deleted', async () => {
    const { log, lines } = setup();
    await log(JOB, made(['v1']));
    await log({ ...JOB, id: 'bbbbbbbbbbbb', name: 'Other' }, made(['v1']));
    expect(await lines()).toHaveLength(2);

    // Deleted and edited again: its versions start at v1 again, made after the old line was logged.
    const again = made(['v1']);
    const later = {
      ...again,
      versions: again.versions.map((v) => ({
        ...v,
        madeAt: new Date(Date.now() + 5_000).toISOString(),
      })),
    };
    await log(JOB, later);
    expect(await lines()).toHaveLength(3);
  });

  it('never rejects: a log it cannot read is a warning', async () => {
    const { dataDir, log, logger } = setup();
    rmSync(dataDir, { recursive: true, force: true });
    // A file where the data folder should be: neither read nor append can work.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dataDir, 'not a folder');
    await expect(log(JOB, made(['v1']))).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    rmSync(dataDir, { force: true });
  });
});

describe('versionIsLogged', () => {
  const entry = (overrides: Record<string, unknown>) =>
    ({
      at: '2026-10-23T10:00:00.000Z',
      from: null,
      source: 'app',
      tag: 'music',
      did: 'Made music v2 for Horizon FPV / Demo (0:39)',
      session: null,
      job: { id: JOB.id, name: 'Demo' },
      usage: {},
      ...overrides,
    }) as Parameters<typeof versionIsLogged>[0][number];
  const version = { id: 'v2' as const, madeAt: '2026-10-23T09:59:00.000Z' };

  it('is true for a music line of this job and version written at or after the version was made', () => {
    expect(versionIsLogged([entry({})], JOB, version)).toBe(true);
    expect(versionIsLogged([entry({ at: version.madeAt })], JOB, version)).toBe(true);
  });

  it('is false for another job, another version, another tag, or a line from before the version was made', () => {
    expect(versionIsLogged([entry({ job: { id: 'other', name: 'Demo' } })], JOB, version)).toBe(
      false,
    );
    expect(versionIsLogged([entry({ did: 'Made music v20 for x' })], JOB, version)).toBe(false);
    expect(versionIsLogged([entry({ tag: 'edit' })], JOB, version)).toBe(false);
    expect(versionIsLogged([entry({ at: '2026-10-23T09:00:00.000Z' })], JOB, version)).toBe(false);
    expect(versionIsLogged([], JOB, version)).toBe(false);
  });
});
