import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import {
  fontRequests,
  fontUses,
  graphicMessages,
  graphics,
  graphicUses,
  jobs,
  luts,
  lutUses,
  pushDevices,
  quickFixes,
  reviewNotes,
  stepRuns,
} from './schema.js';
import { memoryDb } from './test-utils.js';

const opened: StudioDb[] = [];
const dirs: string[] = [];

function track(db: StudioDb): StudioDb {
  opened.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-db-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface TableInfoRow {
  name: string;
}

function columnNames(db: StudioDb, table: string): string[] {
  return (db.sqlite.pragma(`table_info(${table})`) as TableInfoRow[]).map((c) => c.name).sort();
}

function indexNames(db: StudioDb, table: string): string[] {
  return (db.sqlite.pragma(`index_list(${table})`) as TableInfoRow[])
    .map((i) => i.name)
    .filter((name) => !name.startsWith('sqlite_autoindex'))
    .sort();
}

describe('openDatabase', () => {
  it('migrates an empty database to the jobs and step_runs tables', () => {
    const db = track(memoryDb());
    const tables = db.sqlite
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all() as TableInfoRow[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'jobs',
        'step_runs',
        'review_notes',
        'push_devices',
        'graphics',
        'graphic_messages',
        'graphic_uses',
        'luts',
        'lut_uses',
        'font_uses',
        'font_requests',
        'quick_fixes',
        '__drizzle_migrations',
      ]),
    );
  });

  it('has exactly the columns schema.ts declares (a new migration is needed if this fails)', () => {
    const db = track(memoryDb());
    for (const [table, def] of [
      ['jobs', jobs],
      ['step_runs', stepRuns],
      ['review_notes', reviewNotes],
      ['push_devices', pushDevices],
      ['graphics', graphics],
      ['graphic_messages', graphicMessages],
      ['graphic_uses', graphicUses],
      ['luts', luts],
      ['lut_uses', lutUses],
      ['font_uses', fontUses],
      ['font_requests', fontRequests],
      ['quick_fixes', quickFixes],
    ] as const) {
      const declared = Object.values(getTableColumns(def))
        .map((column) => column.name)
        .sort();
      expect(columnNames(db, table), table).toEqual(declared);
    }
  });

  it('stores the columns of architecture section 5', () => {
    const db = track(memoryDb());
    expect(columnNames(db, 'jobs')).toEqual(
      [
        'id',
        'client',
        'name',
        'rel_path',
        'state',
        'step',
        'sub_progress',
        'failed_at',
        'error',
        'stopped_at',
        'inputs',
        'size_bytes',
        'footage_seconds',
        'added_at',
        'updated_at',
        'last_change_at',
        'settled_at',
        'held_settled_at',
        'started_at',
        'finished_at',
        'output',
        'attempt',
        'note',
        'effort',
        'archived_at',
        'run_kind',
        'round',
        'preview',
        'approved_at',
        'review_sec',
        'rel_key',
        'series_id',
        'episode',
        'series_pinned',
        'review_effort',
        'revise_tier',
        'formats',
      ].sort(),
    );
    expect(columnNames(db, 'step_runs')).toEqual(
      ['id', 'job_id', 'step', 'started_at', 'ended_at', 'footage_seconds', 'run_kind'].sort(),
    );
  });

  it('never stores the derived fields', () => {
    const db = track(memoryDb());
    const names = columnNames(db, 'jobs');
    for (const derived of ['place_in_line', 'settles_at', 'eta_sec', 'eta_seconds']) {
      expect(names).not.toContain(derived);
    }
  });

  it('indexes updated_at', () => {
    const db = track(memoryDb());
    const indexed = (db.sqlite.pragma('index_info(jobs_updated_at_idx)') as TableInfoRow[]).map(
      (c) => c.name,
    );
    expect(indexed).toEqual(['updated_at']);
    expect(indexNames(db, 'jobs')).toContain('jobs_updated_at_idx');
  });

  it('turns on WAL and foreign keys for a database file', () => {
    const db = track(openDatabase(join(tempDir(), 'engine.db')));
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates the folder of the database file', () => {
    const path = join(tempDir(), 'nested', 'deeper', 'engine.db');
    track(openDatabase(path)).close();
    expect(() => track(openDatabase(path))).not.toThrow();
  });

  it('keeps its data when opened again, and does not run migrations twice', () => {
    const path = join(tempDir(), 'engine.db');
    const first = track(openDatabase(path));
    first.sqlite
      .prepare(
        `insert into step_runs (job_id, step, started_at, footage_seconds) values ('a', 1, 1, 0)`,
      )
      .run();
    first.close();

    const second = track(openDatabase(path));
    const count = second.sqlite.prepare('select count(*) as n from step_runs').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    const applied = second.sqlite
      .prepare('select count(*) as n from __drizzle_migrations')
      .get() as {
      n: number;
    };
    expect(applied.n).toBeGreaterThanOrEqual(1);
  });

  it('finds the migrations next to src/ and dist/, not inside them', () => {
    expect(MIGRATIONS_FOLDER).toMatch(/apps[\\/]server[\\/]drizzle$/);
  });

  it('fails clearly when the migrations folder is missing', () => {
    expect(() => openDatabase(':memory:', { migrationsFolder: join(tempDir(), 'nope') })).toThrow(
      /migrations not found/,
    );
  });
});
