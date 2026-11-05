// Helpers shared by the database tests. Not part of the server build (see tsconfig.build.json).

import { createHash } from 'node:crypto';
import type { JobPreview } from '@studio/shared';
import { openDatabase, type StudioDb } from './database.js';
import type { ScanResult } from './job-repository.js';

export const T0 = '2026-10-20T10:00:00.000Z';

export interface FakeClock {
  (): Date;
  /** Moves the clock forward and returns the new time. */
  tick(ms?: number): Date;
}

/** A clock that only moves when told to. Starts at `startIso`. */
export function fakeClock(startIso = T0): FakeClock {
  let time = Date.parse(startIso);
  const clock = (): Date => new Date(time);
  clock.tick = (ms = 1_000): Date => {
    time += ms;
    return new Date(time);
  };
  return clock;
}

/** The scanner's id for a folder: first 12 hex characters of sha1 of the NFC relative path. */
export function idFor(relPath: string): string {
  return createHash('sha1').update(relPath.normalize('NFC'), 'utf8').digest('hex').slice(0, 12);
}

/** A scan of `Client/Job`; override what a test cares about. */
export function makeScan(
  client = 'Northwind Bakery',
  name = 'Spring menu',
  overrides: Partial<ScanResult> = {},
): ScanResult {
  const relPath = `${client}/${name}`;
  return {
    id: idFor(relPath),
    client,
    name,
    relPath,
    inputs: { video: 14, audio: 1, image: 0, doc: 1 },
    sizeBytes: 1_181_116_006,
    footageSec: 540.5,
    newestMtimeMs: Date.parse(T0),
    ...overrides,
  };
}

export function memoryDb(): StudioDb {
  return openDatabase(':memory:');
}

/** The stored row exactly as SQLite has it. */
export function rawRow(
  db: StudioDb,
  table:
    | 'jobs'
    | 'step_runs'
    | 'review_notes'
    | 'deliveries'
    | 'graphics'
    | 'graphic_messages'
    | 'graphic_uses'
    | 'luts'
    | 'lut_uses'
    | 'font_uses'
    | 'font_requests'
    | 'quick_fixes'
    | 'job_generate',
  where = '1 = 1',
): unknown[] {
  return db.sqlite.prepare(`select * from ${table} where ${where} order by 1`).all();
}

/** How many rows SQLite has changed on this connection so far (inserts, updates, deletes). */
export function totalChanges(db: StudioDb): number {
  const row = db.sqlite.prepare('select total_changes() as n').get() as { n: number };
  return row.n;
}

/** A preview as W2 reads it from a composition: 28.4 s, vertical Full HD. */
export const SAMPLE_PREVIEW: JobPreview = { durationSec: 28.4, width: 1080, height: 1920 };
