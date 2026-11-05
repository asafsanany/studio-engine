import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobRepository } from './job-repository.js';
import { fakeClock } from './test-utils.js';

// Generated videos, GN0: migration 0022_generate adds the table `job_generate` (one row per job
// that has a Generate stage). These tests build a database as it was before it (migrations 0000 to
// 0021 applied, a job in it) and open it with the full set of migrations.

const NOW = Date.parse('2026-10-25T10:00:00.000Z');

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

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe('migration 0022_generate', () => {
  it('is in the journal, right after the quick fixes', () => {
    const tags = entryTags();
    expect(tags).toContain('0022_generate');
    expect(tags.indexOf('0022_generate')).toBe(tags.indexOf('0021_quick_fixes') + 1);
  });

  it('creates job_generate with the columns of the contract', () => {
    const db = track(openDatabase(join(tempDir(), 'engine.db')));
    const columns = db.sqlite.prepare('pragma table_info(job_generate)').all() as Column[];
    expect(columns.map((column) => column.name)).toEqual([
      'job_id',
      'phase',
      'voice_done',
      'voice_total',
      'looks_done',
      'looks_total',
      'keyframes_done',
      'keyframes_total',
      'clips_done',
      'clips_total',
      'below_bar',
      'spend_usd',
      'budget_usd',
      'elevenlabs_chars',
      'updated_at',
    ]);
    const byName = new Map(columns.map((column) => [column.name, column]));
    expect(byName.get('job_id')).toMatchObject({ pk: 1, type: 'TEXT' });
    expect(byName.get('phase')).toMatchObject({ notnull: 1, type: 'TEXT' });
    expect(byName.get('spend_usd')).toMatchObject({ notnull: 1, type: 'REAL', dflt_value: '0' });
    expect(byName.get('budget_usd')).toMatchObject({ notnull: 1, type: 'REAL', dflt_value: null });
    expect(byName.get('elevenlabs_chars')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(byName.get('clips_total')).toMatchObject({
      notnull: 1,
      type: 'INTEGER',
      dflt_value: '0',
    });
    expect(byName.get('updated_at')).toMatchObject({ notnull: 1, type: 'INTEGER' });
  });

  it('leaves the jobs that were there as they were, none of them generated', () => {
    const path = join(tempDir(), 'engine.db');
    const before = track(openDatabase(path, { migrationsFolder: folderWithFirst(22) }));
    const insert = before.sqlite.prepare(
      `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
         footage_seconds, added_at, updated_at, last_change_at, settled_at)
       values (@id, 'Northwind Bakery', @id, @id, @id, @state,
         '{"video":1,"audio":0,"image":0,"doc":0}', 1000, 10, @at, @at, @at, @settled)`,
    );
    insert.run({ id: 'ready-job', state: 'ready', at: NOW, settled: NOW });
    insert.run({ id: 'arriving-job', state: 'arriving', at: NOW, settled: null });
    const tables = before.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name = 'job_generate'")
      .all();
    expect(tables).toEqual([]);
    before.close();

    const after = track(openDatabase(path));
    expect(
      after.sqlite.prepare("select name from sqlite_master where name = 'job_generate'").all(),
    ).toHaveLength(1);
    expect(after.sqlite.prepare('select count(*) as n from job_generate').get()).toEqual({ n: 0 });

    // Even with the switch on, a job without a row has no `generate`.
    const repo = new JobRepository(after, {
      clock: fakeClock('2026-10-25T10:00:00.000Z'),
      generate: true,
    });
    const jobs = repo.getAll();
    expect(jobs.map((job) => job.id).sort()).toEqual(['arriving-job', 'ready-job']);
    for (const job of jobs) expect(job).not.toHaveProperty('generate');
  });
});
