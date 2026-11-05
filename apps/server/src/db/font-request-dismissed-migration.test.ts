import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { FontRepository } from './font-repository.js';

// C52: migration 0020_font_request_dismissed adds the nullable `font_requests.dismissed_at`
// column ("Not a font" on the Fonts page's bar). These tests build a database as it was before it
// (an open and an imported request in it) and open it with the full set of migrations.

const TAG = '0020_font_request_dismissed';
const AT = Date.parse('2026-10-25T09:00:00.000Z');

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

function journalEntries(): { tag: string }[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  return journal.entries;
}

/** A migrations folder holding only the migrations before this one. */
function folderBeforeThis(): string {
  const folder = tempDir();
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(
    0,
    journalEntries().findIndex((entry) => entry.tag === TAG),
  );
  for (const entry of journal.entries as { tag: string }[]) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

function seedBeforeDismissals(path: string): void {
  const db = openDatabase(path, { migrationsFolder: folderBeforeThis() });
  try {
    const insert = db.sqlite.prepare(
      `insert into font_requests (id, name, job_id, round, at, resolved_at)
       values (@id, @name, 'job-a', 0, @at, @resolvedAt)`,
    );
    insert.run({ id: '00000000000a', name: 'Gotham Bold', at: AT, resolvedAt: null });
    insert.run({ id: '00000000000b', name: 'Outfit', at: AT, resolvedAt: AT + 1000 });
  } finally {
    db.close();
  }
}

describe('migration 0020_font_request_dismissed', () => {
  it('follows the fonts migration', () => {
    const tags = journalEntries().map((entry) => entry.tag);
    expect(tags.indexOf(TAG)).toBe(tags.indexOf('0019_fonts') + 1);
  });

  it('adds a nullable dismissed_at column and keeps every request as it was', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeDismissals(path);

    const db = openDatabase(path);
    opened.push(db);

    expect(
      db.sqlite
        .prepare(
          "select name, type, [notnull] as required from pragma_table_info('font_requests') where name = 'dismissed_at'",
        )
        .all(),
    ).toEqual([{ name: 'dismissed_at', type: 'INTEGER', required: 0 }]);
    expect(
      db.sqlite
        .prepare('select id, name, resolved_at, dismissed_at from font_requests order by id')
        .all(),
    ).toEqual([
      { id: '00000000000a', name: 'Gotham Bold', resolved_at: null, dismissed_at: null },
      { id: '00000000000b', name: 'Outfit', resolved_at: AT + 1000, dismissed_at: null },
    ]);
  });

  it('shows the old requests as they were, and lets the open one be dismissed', () => {
    const path = join(tempDir(), 'engine.db');
    seedBeforeDismissals(path);
    const db = openDatabase(path);
    opened.push(db);
    const repo = new FontRepository(db);

    expect(repo.openRequests(0).map((request) => request.name)).toEqual(['Gotham Bold']);
    expect(repo.dismissRequest('00000000000a')).toBe(1);

    expect(repo.openRequests(0)).toEqual([]);
    expect(repo.recordRequest('gotham bold', 'job-a', 4).added).toBe(false);
    // An import had answered the other one: it can be asked for again.
    expect(repo.recordRequest('Outfit', 'job-a', 4).added).toBe(true);
  });
});
