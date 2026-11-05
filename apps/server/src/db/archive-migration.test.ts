import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { fakeClock } from './test-utils.js';

// CVP-196: migration 0012_archived_at adds the nullable `jobs.archived_at` column (null = not
// archived). These tests build a database as it was before it (migrations 0000 to 0011 applied,
// jobs in it) and open it with the full set of migrations.

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

describe('migration 0012_archived_at', () => {
  it('is in the journal, after series', () => {
    const tags = entryTags();
    expect(tags).toContain('0012_archived_at');
    expect(tags.indexOf('0012_archived_at')).toBe(tags.indexOf('0011_series') + 1);
  });

  it('adds jobs.archived_at, and no job that was there is archived (null)', () => {
    const dir = tempDir();
    const path = join(dir, 'engine.db');
    const before = track(openDatabase(path, { migrationsFolder: folderWithFirst(12) }));
    const insert = before.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at)
       values (@id, 'Northwind Bakery', @id, @id, @id, @state,
         '{"video":1,"audio":0,"image":0,"doc":0}', 1000, 10, @at, @at, @at, @settled)`,
    );
    insert.run({ id: 'ready-job', state: 'ready', at: NOW, settled: NOW });
    insert.run({ id: 'arriving-job', state: 'arriving', at: NOW, settled: null });
    const columns = before.sqlite.prepare('pragma table_info(jobs)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('archived_at');
    before.close();

    const after = track(openDatabase(path));
    const columnsAfter = after.sqlite.prepare('pragma table_info(jobs)').all() as {
      name: string;
      notnull: number;
      type: string;
    }[];
    expect(columnsAfter.find((column) => column.name === 'archived_at')).toMatchObject({
      notnull: 0,
      type: 'INTEGER',
    });

    const repo = new JobRepository(after, { clock: fakeClock('2026-10-21T10:00:00.000Z') });
    expect(repo.getAll().map((job) => [job.id, job.archivedAt])).toEqual(
      expect.arrayContaining([
        ['ready-job', null],
        ['arriving-job', null],
      ]),
    );
    expect(repo.archive(['ready-job']).jobs[0]?.archivedAt).toBe('2026-10-21T10:00:00.000Z');
  });
});
