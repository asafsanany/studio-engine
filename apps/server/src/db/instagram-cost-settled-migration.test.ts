import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { InstagramRepository } from './instagram-repository.js';

// Clients × Instagram, C90: migration 0027_instagram_cost_settled adds `instagram_scans.cost_settled_at`
// (when a scan's cost was checked against Apify's runs again). A scan stored before it has no such
// time, so the cost check finds it and corrects it: the two live scans (ids 1 and 2, cost 0.001 each)
// are fixed that way. These tests build a database as it was before the migration (0000 to 0026
// applied, those two scans in it) and open it with the full set of migrations.

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

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

function journal(): { entries: { tag: string }[] } {
  return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
}

const TAGS = journal().entries.map((entry) => entry.tag);
const MIGRATION = '0027_instagram_cost_settled';

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

/** The database file of the live engine on 30 Oct: two ended scans with the early cost. */
function seedBeforeMigration(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderWithFirst(TAGS.indexOf(MIGRATION)) });
  try {
    const insert = db.sqlite.prepare(
      `insert into instagram_scans
         (client_id, handle, started_at, finished_at, outcome, followers, reels_read, cost_usd, apify_run_ids)
       values (?, ?, ?, ?, 'ok', 100, 12, 0.001, ?)`,
    );
    insert.run(
      'c-falcon',
      'falcon.fpv',
      NOW - 26 * HOUR,
      NOW - 26 * HOUR + 60_000,
      JSON.stringify(['WyEPcvSheL00CIhy5', '1QpsgCch2e0zmSMqQ']),
    );
    insert.run(
      'c-hillside',
      'hillside_winery',
      NOW - 25 * HOUR,
      NOW - 25 * HOUR + 60_000,
      JSON.stringify(['NndRNTgmdB68pfADq', 'UosBChF4U98hfDmdH']),
    );
  } finally {
    db.close();
  }
}

describe('migration 0027_instagram_cost_settled', () => {
  it('is in the journal, right after 0026_instagram', () => {
    expect(TAGS).toContain(MIGRATION);
    expect(TAGS.indexOf(MIGRATION)).toBe(TAGS.indexOf('0026_instagram') + 1);
  });

  it('is one nullable column on instagram_scans, nothing else', () => {
    const sql = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION}.sql`), 'utf8');
    expect(sql.trim()).toBe('ALTER TABLE `instagram_scans` ADD `cost_settled_at` integer;');
  });

  it('leaves the scans stored before it unchecked, so the first check corrects them', () => {
    const path = join(tempDir(), 'studio.db');
    seedBeforeMigration(path);

    const db = openDatabase(path);
    opened.push(db);
    const instagram = new InstagramRepository(db);

    const waiting = instagram.scansToSettle(NOW);
    expect(waiting.map((scan) => scan.id)).toEqual([1, 2]);
    expect(waiting.map((scan) => scan.costUsd)).toEqual([0.001, 0.001]);
    expect(waiting[0]?.apifyRunIds).toEqual(['WyEPcvSheL00CIhy5', '1QpsgCch2e0zmSMqQ']);
    expect(waiting[1]?.apifyRunIds).toEqual(['NndRNTgmdB68pfADq', 'UosBChF4U98hfDmdH']);
    // The scans read as they did.
    expect(instagram.getScan(1)).toMatchObject({
      clientId: 'c-falcon',
      outcome: 'ok',
      reelsRead: 12,
      costUsd: 0.001,
    });
    expect(instagram.getScan(1)).not.toHaveProperty('costSettledAt');
  });

  it('lets the scans be corrected once, and not again', () => {
    const path = join(tempDir(), 'studio.db');
    seedBeforeMigration(path);
    const db = openDatabase(path);
    opened.push(db);
    const instagram = new InstagramRepository(db);

    instagram.settleScanCost(1, 0.0348, NOW);
    instagram.settleScanCost(2, 0.027, NOW);

    expect(instagram.scansToSettle(NOW + HOUR)).toEqual([]);
    expect(instagram.listScanCosts().map((scan) => scan.costUsd)).toEqual([0.0348, 0.027]);
  });
});
