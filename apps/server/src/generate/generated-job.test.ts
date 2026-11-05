import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GenerateState } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerateRepository } from '../db/generate-repository.js';
import { fakeClock, memoryDb } from '../db/test-utils.js';
import {
  budgetNumberText,
  budgetOfGeneratedJob,
  readGeneratedJob,
  readSpentUsd,
  syncGeneratedSpend,
} from './generated-job.js';

let jobDir: string;

beforeEach(() => {
  jobDir = mkdtempSync(join(tmpdir(), 'studio-generated-job-'));
  mkdirSync(join(jobDir, 'edit', 'generate'), { recursive: true });
});

afterEach(() => {
  rmSync(jobDir, { recursive: true, force: true });
});

const put = (path: string, content: string) => writeFileSync(join(jobDir, path), content);

describe('readGeneratedJob', () => {
  it('is the brief of a job whose brief says production: generate', async () => {
    put('edit/brief.json', JSON.stringify({ schema: 1, production: 'generate', budgetUsd: null }));
    expect(await readGeneratedJob(jobDir)).toEqual({ budgetUsd: null });
  });

  it('carries the budget a note gave the brief, and only a positive number', async () => {
    put('edit/brief.json', JSON.stringify({ production: 'generate', budgetUsd: 5 }));
    expect(await readGeneratedJob(jobDir)).toEqual({ budgetUsd: 5 });
    for (const budgetUsd of [0, -1, '5', null]) {
      put('edit/brief.json', JSON.stringify({ production: 'generate', budgetUsd }));
      expect(await readGeneratedJob(jobDir)).toEqual({ budgetUsd: null });
    }
  });

  it.each([
    ['footage', { production: 'footage' }],
    ['not said', { production: null }],
    ['absent', { summary: 'x' }],
    ['an array', []],
    ['a string', 'generate'],
    ['null', null],
  ])('is null for a brief that says %s', async (_name, brief) => {
    put('edit/brief.json', JSON.stringify(brief));
    expect(await readGeneratedJob(jobDir)).toBeNull();
  });

  it('is null for no brief and for a file that does not parse, and never throws', async () => {
    expect(await readGeneratedJob(jobDir)).toBeNull();
    put('edit/brief.json', '{ nope');
    expect(await readGeneratedJob(jobDir)).toBeNull();
    expect(await readGeneratedJob(join(jobDir, 'no such folder'))).toBeNull();
  });
});

describe('readSpentUsd', () => {
  const entry = (usd: number, refunded: boolean) => ({
    at: '2026-10-25T10:00:00.000Z',
    kind: 'clip',
    slug: 'alibaba/wan-3.0/image-to-video',
    usd,
    requestId: null,
    refunded,
  });

  it('adds up the entries that were not refunded, never the file’s own total', async () => {
    put(
      'edit/generate/spend.json',
      JSON.stringify({
        entries: [entry(1.5, false), entry(0.83, false), entry(0.4, true)],
        total: 99,
      }),
    );
    expect(await readSpentUsd(jobDir)).toBe(2.33);
  });

  it('is 0 when there is no spend.json yet or it does not parse', async () => {
    expect(await readSpentUsd(jobDir)).toBe(0);
    put('edit/generate/spend.json', '{ nope');
    expect(await readSpentUsd(jobDir)).toBe(0);
    put('edit/generate/spend.json', JSON.stringify({ nothing: true }));
    expect(await readSpentUsd(jobDir)).toBe(0);
  });
});

describe('the budget', () => {
  it('is the brief’s own, else the configured one, else the default of the switch', () => {
    expect(budgetOfGeneratedJob({ budgetUsd: 5 }, 4)).toBe(5);
    expect(budgetOfGeneratedJob({ budgetUsd: null }, 4)).toBe(4);
    expect(budgetOfGeneratedJob({ budgetUsd: null }, undefined)).toBe(5);
  });

  it('is written as the number a command line takes', () => {
    expect(budgetNumberText(3)).toBe('3');
    expect(budgetNumberText(4.5)).toBe('4.5');
    expect(budgetNumberText(12.25)).toBe('12.25');
    expect(budgetNumberText(2.999)).toBe('3');
  });
});

describe('syncGeneratedSpend (C67)', () => {
  const dbs: ReturnType<typeof memoryDb>[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.sqlite.open) db.close();
  });
  function repoOf() {
    const db = memoryDb();
    dbs.push(db);
    return new GenerateRepository(db, { clock: fakeClock() });
  }
  const spendFile = (...usds: number[]) =>
    put(
      'edit/generate/spend.json',
      JSON.stringify({ rows: usds.map((usd) => ({ estimate_usd: usd, usd })) }),
    );

  it('puts what spend.json says into the row and tells onChanged with the new state', async () => {
    const repo = repoOf();
    repo.start('job-a', 3);
    repo.update('job-a', { spendUsd: 2.33 });
    put(
      'edit/generate/spend.json',
      JSON.stringify({
        entries: [
          { id: 'A', usd: 2.33 },
          { id: 'B-take2', usd: 0.51 },
          { id: 'C', usd: 0.3, refunded: true },
        ],
        total: 2.84,
      }),
    );
    const told: Array<[string, GenerateState]> = [];

    await syncGeneratedSpend(repo, 'job-a', jobDir, (id, state) => told.push([id, state]));

    expect(repo.get('job-a')?.spendUsd).toBe(2.84);
    expect(told).toHaveLength(1);
    expect(told[0]?.[0]).toBe('job-a');
    expect(told[0]?.[1].spendUsd).toBe(2.84);
    expect(told[0]?.[1].budgetUsd).toBe(3);
  });

  it('brings the row to the budget the brief names, and leaves it alone when the brief names none (C77)', async () => {
    const repo = repoOf();
    repo.start('job-a', 3);
    put('edit/brief.json', JSON.stringify({ production: 'generate', budgetUsd: 4 }));
    put(
      'edit/generate/spend.json',
      JSON.stringify({ entries: [{ id: 'A', usd: 2.93 }], total: 2.93 }),
    );
    const told: GenerateState[] = [];

    await syncGeneratedSpend(repo, 'job-a', jobDir, (_id, state) => told.push(state));

    expect(repo.get('job-a')).toMatchObject({ budgetUsd: 4, spendUsd: 2.93 });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ budgetUsd: 4, spendUsd: 2.93 });

    // No budget in the brief: the stored one stays.
    put('edit/brief.json', JSON.stringify({ production: 'generate', budgetUsd: null }));
    repo.update('job-a', { budgetUsd: 5 });
    await syncGeneratedSpend(repo, 'job-a', jobDir, () => {});
    expect(repo.get('job-a')?.budgetUsd).toBe(5);
  });

  it('says nothing when the row already has that total', async () => {
    const repo = repoOf();
    repo.start('job-a', 3);
    repo.update('job-a', { spendUsd: 1.5 });
    put(
      'edit/generate/spend.json',
      JSON.stringify({ entries: [{ id: 'A', usd: 1.5 }], total: 1.5 }),
    );
    const onChanged = vi.fn();

    await syncGeneratedSpend(repo, 'job-a', jobDir, onChanged);

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('leaves a job with no Generate row alone (a footage job)', async () => {
    const repo = repoOf();
    put(
      'edit/generate/spend.json',
      JSON.stringify({ entries: [{ id: 'A', usd: 1.5 }], total: 1.5 }),
    );
    const onChanged = vi.fn();

    await syncGeneratedSpend(repo, 'footage-job', jobDir, onChanged);

    expect(repo.get('footage-job')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('never throws: a repository that fails leaves the display as it was', async () => {
    const onChanged = vi.fn();
    const broken = {
      get: () => {
        throw new Error('database is locked');
      },
      update: () => null,
    };
    spendFile(1);

    await expect(syncGeneratedSpend(broken, 'job-a', jobDir, onChanged)).resolves.toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
