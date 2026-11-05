import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { NoteRepository } from './note-repository.js';

// Generated videos (GN8): migration 0024_note_format adds the nullable review_notes.format. A note
// from before it reads as the main format, and a new note keeps the format it is given.

const TAG = '0024_note_format';
const NOW = Date.parse('2026-10-25T20:00:00.000Z');

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

/** A migrations folder holding only the migrations before this one. */
function folderBeforeThis(): string {
  const folder = tempDir();
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(
    0,
    journal.entries.findIndex((entry: { tag: string }) => entry.tag === TAG),
  );
  for (const entry of journal.entries as { tag: string }[]) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  return folder;
}

describe('migration 0024_note_format', () => {
  it('keeps the notes written before it as the main format and takes a format after', () => {
    const path = join(tempDir(), 'engine.db');
    const before = openDatabase(path, { migrationsFolder: folderBeforeThis() });
    before.sqlite
      .prepare(
        `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
           footage_seconds, added_at, updated_at, last_change_at)
         values ('j1', 'Pinewood', '97 Window Ad', 'Pinewood/97 Window Ad', 'pinewood/97 window ad', 'review',
           '{"video":0,"audio":0,"image":0,"doc":0}', 1000, 0, @at, @at, @at)`,
      )
      .run({ at: NOW });
    before.sqlite
      .prepare(
        `insert into review_notes (id, job_id, round, at_sec, kind, text, created_at)
         values ('old', 'j1', null, 2.4, 'text', 'The title goes too fast.', @at)`,
      )
      .run({ at: NOW });
    before.close();

    const db = openDatabase(path);
    opened.push(db);

    const column = db.sqlite
      .prepare(
        `select name, type, [notnull] as required, dflt_value as dflt
         from pragma_table_info('review_notes') where name = 'format'`,
      )
      .get();
    expect(column).toEqual({ name: 'format', type: 'TEXT', required: 0, dflt: null });

    const notes = new NoteRepository(db, { clock: () => new Date(NOW) });
    expect(notes.get('old')?.format).toBeNull();
    const added = notes.create({
      id: 'new',
      jobId: 'j1',
      kind: 'text',
      atSec: 32,
      text: 'Logo bigger.',
      format: '1x1',
    });
    expect(added.format).toBe('1x1');
    expect(notes.get('new')?.format).toBe('1x1');
    expect(
      notes.create({ id: 'main', jobId: 'j1', kind: 'text', atSec: 1, text: 'Hi.' }).format,
    ).toBeNull();
  });
});
