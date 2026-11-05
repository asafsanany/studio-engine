import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

/**
 * Where the committed migration SQL lives: `apps/server/drizzle`, outside `src/` so the compiled
 * server finds the same files. Both `src/db/` and `dist/db/` are two levels below `apps/server`.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export const IN_MEMORY = ':memory:';

export type StudioOrm = BetterSQLite3Database<typeof schema>;

/** An open, migrated database. */
export interface StudioDb {
  /** The drizzle query builder over `sqlite`. */
  orm: StudioOrm;
  /** The raw better-sqlite3 connection (transactions, pragmas). */
  sqlite: Database.Database;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Defaults to {@link MIGRATIONS_FOLDER}. */
  migrationsFolder?: string;
}

/**
 * Opens the SQLite file at `path` (`:memory:` for tests), creating its folder, switches on WAL and
 * foreign keys, and applies every migration that has not run yet. Throws if the migrations folder
 * is missing or a migration fails, so the caller can stop the boot.
 */
export function openDatabase(
  path: string,
  { migrationsFolder = MIGRATIONS_FOLDER }: OpenDatabaseOptions = {},
): StudioDb {
  if (!existsSync(migrationsFolder)) {
    throw new Error(`Database migrations not found at ${migrationsFolder}`);
  }
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  try {
    // WAL keeps readers and the single writer out of each other's way and survives a crash
    // without a lost write; NORMAL is the matching, recommended durability for WAL.
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');

    const orm = drizzle(sqlite, { schema });
    migrate(orm, { migrationsFolder });
    return { orm, sqlite, close: () => sqlite.close() };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}
