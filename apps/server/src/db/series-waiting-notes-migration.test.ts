import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { SeriesRepository } from './series-repository.js';

// CVP-256 (C26): migration 0014_series_waiting_notes adds the nullable `series.waiting_notes`
// column (null = no review notes wait for an episode's approval). These tests build a database as
// it was before it (migrations 0000 to 0013 applied, a series in it) and open it with the full set.

const NOW = Date.parse('2026-10-22T10:00:00.000Z');

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

describe('migration 0014_series_waiting_notes', () => {
  it('is in the journal, after the effort levels', () => {
    const tags = entryTags();
    expect(tags.indexOf('0014_series_waiting_notes')).toBe(tags.indexOf('0013_effort_levels') + 1);
  });

  it('adds series.waiting_notes, and a series that was there has no notes waiting', () => {
    const path = join(tempDir(), 'engine.db');
    const before = track(openDatabase(path, { migrationsFolder: folderWithFirst(14) }));
    before.sqlite
      .prepare(
        `insert into series (id, client_id, client, name, name_key, format_job_id, format_job,
           state, version, created_at, updated_at)
         values ('s1', 'c1', 'Kova Coffee', 'Weekly', 'weekly', 'j5', 'Weekly 5', 'ready', 1,
           @at, @at)`,
      )
      .run({ at: NOW });
    const columns = before.sqlite.prepare('pragma table_info(series)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('waiting_notes');
    before.close();

    const after = track(openDatabase(path));
    const columnsAfter = after.sqlite.prepare('pragma table_info(series)').all() as {
      name: string;
      notnull: number;
      type: string;
    }[];
    expect(columnsAfter.find((column) => column.name === 'waiting_notes')).toMatchObject({
      notnull: 0,
      type: 'TEXT',
    });

    const repo = new SeriesRepository(after);
    expect(repo.waitingNotes('s1')).toEqual([]);
    expect(repo.get('s1')).toMatchObject({ state: 'ready', version: 1 });
    expect(repo.addWaitingNotes('s1', [{ jobId: 'j6', name: 'notes.md', size: 3 }])).toEqual([
      { jobId: 'j6', name: 'notes.md', size: 3 },
    ]);
  });
});
