import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { DeliveryRepository } from './delivery-repository.js';
import { InstagramRepository } from './instagram-repository.js';
import { JobRepository } from './job-repository.js';

// Clients × Instagram, IG1: migration 0026_instagram adds the tables `instagram_accounts`,
// `instagram_scans`, `instagram_reels` and `instagram_reel_reads`. These tests build a database as
// it was before it (migrations 0000 to 0025 applied, a job and its delivery in it) and open it
// with the full set of migrations.

const NOW = Date.parse('2026-10-30T10:00:00.000Z');

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

function journal(): { entries: { tag: string }[] } {
  return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
}

function entryTags(): string[] {
  return journal().entries.map((entry) => entry.tag);
}

/** A migrations folder holding only the first `count` migrations of the real one. */
function folderWithFirst(count: number): string {
  const folder = tempDir();
  mkdirSync(join(folder, 'meta'));
  const all = journal();
  all.entries = all.entries.slice(0, count);
  for (const entry of all.entries) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(all));
  return folder;
}

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columnsOf(db: StudioDb, table: string): Map<string, Column> {
  const columns = db.sqlite.prepare(`pragma table_info(${table})`).all() as Column[];
  return new Map(columns.map((column) => [column.name, column]));
}

/** The indexes of a table by name: whether unique, and the columns in order. */
function indexesOf(db: StudioDb, table: string): Record<string, { unique: boolean; on: string[] }> {
  const list = db.sqlite.prepare(`pragma index_list(${table})`).all() as {
    name: string;
    unique: number;
    origin: string;
  }[];
  return Object.fromEntries(
    list
      .filter((index) => index.origin === 'c')
      .map((index) => [
        index.name,
        {
          unique: index.unique === 1,
          on: (
            db.sqlite.prepare(`pragma index_info(${index.name})`).all() as { name: string }[]
          ).map((column) => column.name),
        },
      ]),
  );
}

describe('migration 0026_instagram', () => {
  it('is in the journal, right after paid_amount', () => {
    const tags = entryTags();
    expect(tags).toContain('0026_instagram');
    expect(tags.indexOf('0026_instagram')).toBe(tags.indexOf('0025_paid_amount') + 1);
  });

  it('is the four new tables and their indexes, nothing else', () => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, '0026_instagram.sql'), 'utf8');
    expect(sql.match(/CREATE TABLE `(\w+)`/g)).toEqual([
      'CREATE TABLE `instagram_accounts`',
      'CREATE TABLE `instagram_reel_reads`',
      'CREATE TABLE `instagram_reels`',
      'CREATE TABLE `instagram_scans`',
    ]);
    expect(sql).not.toMatch(/ALTER |DROP |DELETE |INSERT |UPDATE /);
  });

  it('creates instagram_accounts with the columns of the plan', () => {
    const db = track(openDatabase(':memory:'));
    const columns = columnsOf(db, 'instagram_accounts');
    expect([...columns.keys()]).toEqual([
      'client_id',
      'client',
      'handle',
      'instagram_id',
      'since',
      'added_at',
      'full_name',
      'biography',
      'private',
      'photo_saved_at',
    ]);
    expect(columns.get('client_id')).toMatchObject({ pk: 1, type: 'TEXT', notnull: 1 });
    expect(columns.get('handle')).toMatchObject({ notnull: 1, type: 'TEXT' });
    expect(columns.get('instagram_id')).toMatchObject({ notnull: 0 });
    expect(columns.get('since')).toMatchObject({ notnull: 0, type: 'TEXT' });
    expect(columns.get('added_at')).toMatchObject({ notnull: 1, type: 'INTEGER' });
    expect(columns.get('private')).toMatchObject({ notnull: 1, dflt_value: 'false' });
    expect(columns.get('photo_saved_at')).toMatchObject({ notnull: 0, type: 'INTEGER' });
  });

  it('creates instagram_scans with the columns of the plan and an index on client and start', () => {
    const db = track(openDatabase(':memory:'));
    const columns = columnsOf(db, 'instagram_scans');
    expect([...columns.keys()]).toEqual([
      'id',
      'client_id',
      'handle',
      'started_at',
      'finished_at',
      'outcome',
      'error',
      'followers',
      'following',
      'posts',
      'reels_read',
      'cost_usd',
      'apify_run_ids',
      // Added by 0027_instagram_cost_settled (C90).
      'cost_settled_at',
    ]);
    expect(columns.get('id')).toMatchObject({ pk: 1, type: 'INTEGER' });
    expect(columns.get('finished_at')).toMatchObject({ notnull: 0 });
    expect(columns.get('outcome')).toMatchObject({ notnull: 0, type: 'TEXT' });
    expect(columns.get('followers')).toMatchObject({ notnull: 0, type: 'INTEGER' });
    expect(columns.get('cost_usd')).toMatchObject({ notnull: 1, type: 'REAL', dflt_value: '0' });
    expect(columns.get('apify_run_ids')).toMatchObject({ notnull: 1, dflt_value: "'[]'" });
    expect(indexesOf(db, 'instagram_scans')).toEqual({
      instagram_scans_client_started_idx: { unique: false, on: ['client_id', 'started_at'] },
    });
  });

  it('creates instagram_reels with the columns of the plan and its indexes', () => {
    const db = track(openDatabase(':memory:'));
    const columns = columnsOf(db, 'instagram_reels');
    expect([...columns.keys()]).toEqual([
      'shortcode',
      'client_id',
      'url',
      'posted_at',
      'caption',
      'duration_sec',
      'plays',
      'likes',
      'comments',
      'shares',
      'sound',
      'coauthors',
      'hashtags',
      'pinned',
      'paid_partnership',
      'first_scan_id',
      'last_scan_id',
      'job_id',
      'linked_at',
    ]);
    expect(columns.get('shortcode')).toMatchObject({ pk: 1, type: 'TEXT' });
    expect(columns.get('shares')).toMatchObject({ notnull: 0, type: 'INTEGER' });
    expect(columns.get('plays')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(columns.get('coauthors')).toMatchObject({ notnull: 1, dflt_value: "'[]'" });
    expect(columns.get('hashtags')).toMatchObject({ notnull: 1, dflt_value: "'[]'" });
    expect(columns.get('pinned')).toMatchObject({ notnull: 1, dflt_value: 'false' });
    expect(columns.get('job_id')).toMatchObject({ notnull: 0, type: 'TEXT' });
    expect(columns.get('linked_at')).toMatchObject({ notnull: 0, type: 'INTEGER' });
    expect(indexesOf(db, 'instagram_reels')).toEqual({
      instagram_reels_client_posted_idx: { unique: false, on: ['client_id', 'posted_at'] },
      instagram_reels_posted_at_idx: { unique: false, on: ['posted_at'] },
      instagram_reels_job_id_unique: { unique: true, on: ['job_id'] },
    });
  });

  it('lets many reels have no job and refuses a job on two reels', () => {
    const db = track(openDatabase(':memory:'));
    const insert = db.sqlite.prepare(
      `insert into instagram_reels (shortcode, client_id, url, posted_at, first_scan_id,
         last_scan_id, job_id)
       values (@shortcode, 'c1', 'https://www.instagram.com/reel/x/', 1, 1, 1, @jobId)`,
    );

    insert.run({ shortcode: 'a', jobId: null });
    insert.run({ shortcode: 'b', jobId: null });
    insert.run({ shortcode: 'c', jobId: 'job-1' });

    expect(() => insert.run({ shortcode: 'd', jobId: 'job-1' })).toThrow(/UNIQUE/);
  });

  it('creates instagram_reel_reads keyed by reel and scan', () => {
    const db = track(openDatabase(':memory:'));
    const columns = columnsOf(db, 'instagram_reel_reads');
    expect([...columns.keys()]).toEqual([
      'shortcode',
      'scan_id',
      'plays',
      'likes',
      'comments',
      'shares',
    ]);
    expect(columns.get('shortcode')).toMatchObject({ pk: 1 });
    expect(columns.get('scan_id')).toMatchObject({ pk: 2 });
    expect(columns.get('shares')).toMatchObject({ notnull: 0 });
    const insert = db.sqlite.prepare(
      'insert into instagram_reel_reads (shortcode, scan_id, plays, likes, comments) values (?, ?, 1, 1, 1)',
    );
    insert.run('a', 1);
    insert.run('a', 2);
    insert.run('b', 1);
    expect(() => insert.run('a', 1)).toThrow(/UNIQUE|PRIMARY/);
  });

  it('leaves the jobs and deliveries that were there as they were, with no Instagram data', () => {
    const path = join(tempDir(), 'engine.db');
    const before = track(
      openDatabase(path, {
        migrationsFolder: folderWithFirst(entryTags().indexOf('0026_instagram')),
      }),
    );
    before.sqlite
      .prepare(
        `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
           footage_seconds, added_at, updated_at, last_change_at, settled_at)
         values ('ready-job', 'Northwind Bakery', 'Spring menu', 'Northwind Bakery/Spring menu',
           'Northwind Bakery/Spring menu', 'ready',
           '{"video":1,"audio":0,"image":0,"doc":0}', 1000, 10, @at, @at, @at, @at)`,
      )
      .run({ at: NOW });
    before.sqlite
      .prepare(
        `insert into deliveries (job_id, client_id, client, name, rel_path, delivered_at, price)
         values ('ready-job', 'c1', 'Northwind Bakery', 'Spring menu', 'Northwind Bakery/Spring menu', ?, 40)`,
      )
      .run(NOW);
    expect(
      before.sqlite.prepare("select name from sqlite_master where name like 'instagram_%'").all(),
    ).toEqual([]);
    before.close();

    const after = track(openDatabase(path));

    expect(
      after.sqlite
        .prepare(
          "select name from sqlite_master where type = 'table' and name like 'instagram_%' order by name",
        )
        .all(),
    ).toEqual([
      { name: 'instagram_accounts' },
      { name: 'instagram_reel_reads' },
      { name: 'instagram_reels' },
      { name: 'instagram_scans' },
    ]);
    for (const table of ['accounts', 'scans', 'reels', 'reel_reads']) {
      expect(after.sqlite.prepare(`select count(*) as n from instagram_${table}`).get()).toEqual({
        n: 0,
      });
    }
    expect(new JobRepository(after).getAll()).toMatchObject([{ id: 'ready-job', state: 'ready' }]);
    expect(new DeliveryRepository(after).list()).toMatchObject([{ jobId: 'ready-job', price: 40 }]);
  });

  it('runs once: opening the migrated database again keeps what was saved', () => {
    const path = join(tempDir(), 'engine.db');
    const first = openDatabase(path);
    const instagram = new InstagramRepository(first);
    instagram.upsertAccount({ clientId: 'c1', client: 'Falcon FPV', handle: '@Falcon.FPV' });
    const scan = instagram.startScan({ clientId: 'c1', handle: 'falcon.fpv', startedAt: NOW });
    first.close();

    const db = track(openDatabase(path));

    expect(new InstagramRepository(db).getAccount('c1')).toMatchObject({ handle: 'falcon.fpv' });
    expect(new InstagramRepository(db).getScan(scan.id)).toMatchObject({ startedAt: NOW });
    expect(db.sqlite.prepare('select count(*) as n from __drizzle_migrations').get()).toEqual({
      n: journal().entries.length,
    });
  });
});
