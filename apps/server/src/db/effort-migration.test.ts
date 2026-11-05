import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { fakeClock } from './test-utils.js';

// CVP-192: migration 0010_effort adds the nullable `jobs.effort` column (null = Default). These
// tests build a database as it was before it (migrations 0000 to 0009 applied, jobs in it) and
// open it with the full set of migrations.

const NOW = Date.parse('2026-10-21T10:00:00.000Z');

const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-migration-'));
  dirs.push(dir);
  return dir;
}

function track(db: StudioDb): StudioDb {
  opened.push(db);
  return db;
}

/** A migrations folder holding only the first `count` migrations of the real one. */
function folderWithFirst(count: number): string {
  const folder = tempDir();
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, count);
  for (const entry of journal.entries as { tag: string }[]) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

function entryTags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries.map((entry: { tag: string }) => entry.tag);
}

describe('migration 0010_effort', () => {
  it('is in the journal, after paid_on', () => {
    const tags = entryTags();
    expect(tags).toContain('0010_effort');
    expect(tags.indexOf('0010_effort')).toBe(tags.indexOf('0009_paid_on') + 1);
  });

  it('adds jobs.effort, and every job that was there is on Default (null)', () => {
    const dir = tempDir();
    const path = join(dir, 'engine.db');
    const before = track(openDatabase(path, { migrationsFolder: folderWithFirst(10) }));
    const insert = before.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at)
       values (@id, 'Northwind Bakery', @id, @id, @id, @state,
         '{"video":1,"audio":0,"image":0,"doc":0}', 1000, 10, @at, @at, @at, @settled)`,
    );
    insert.run({ id: 'queued-job', state: 'queued', at: NOW, settled: NOW });
    insert.run({ id: 'arriving-job', state: 'arriving', at: NOW, settled: null });
    const columns = before.sqlite.prepare('pragma table_info(jobs)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('effort');
    before.close();

    const after = track(openDatabase(path));
    const columnsAfter = after.sqlite.prepare('pragma table_info(jobs)').all() as {
      name: string;
      notnull: number;
    }[];
    expect(columnsAfter.find((column) => column.name === 'effort')).toMatchObject({ notnull: 0 });

    const repo = new JobRepository(after, { clock: fakeClock('2026-10-21T10:00:00.000Z') });
    expect(repo.getAll().map((job) => [job.id, job.effort])).toEqual(
      expect.arrayContaining([
        ['queued-job', null],
        ['arriving-job', null],
      ]),
    );
    expect(repo.setEffort('queued-job', 'high').effort).toBe('high');
  });
});

// Low and Max left the list of levels, and Default became Extra high: migration 0013 moves the jobs
// that had them to the nearest level that is left.
describe('migration 0013_effort_levels', () => {
  it('is in the journal, after the ones before it', () => {
    const tags = entryTags();
    expect(tags.indexOf('0013_effort_levels')).toBeGreaterThan(tags.indexOf('0010_effort'));
  });

  it('turns Low into Medium and Max into Extra high, and leaves every other job as it was', () => {
    const dir = tempDir();
    const path = join(dir, 'engine.db');
    const tags = entryTags();
    const before = track(
      openDatabase(path, { migrationsFolder: folderWithFirst(tags.indexOf('0013_effort_levels')) }),
    );
    const insert = before.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at, effort)
       values (@id, 'Northwind Bakery', @id, @id, @id, 'queued',
         '{"video":1,"audio":0,"image":0,"doc":0}', 1000, 10, @at, @at, @at, @at, @effort)`,
    );
    for (const [id, effort] of [
      ['was-low', 'low'],
      ['was-medium', 'medium'],
      ['was-high', 'high'],
      ['was-xhigh', 'xhigh'],
      ['was-max', 'max'],
      ['was-default', null],
    ] as const) {
      insert.run({ id, effort, at: NOW });
    }
    before.close();

    const after = track(openDatabase(path));
    const repo = new JobRepository(after, { clock: fakeClock('2026-10-21T10:00:00.000Z') });
    const levels = Object.fromEntries(repo.getAll().map((job) => [job.id, job.effort]));
    expect(levels).toEqual({
      'was-low': 'medium',
      'was-medium': 'medium',
      'was-high': 'high',
      'was-xhigh': 'xhigh',
      'was-max': 'xhigh',
      'was-default': null,
    });
  });
});
