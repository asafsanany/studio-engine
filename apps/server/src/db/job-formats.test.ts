import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, openDatabase, type StudioDb } from './database.js';
import { JobNotFoundError, JobRepository } from './job-repository.js';
import { fakeClock, makeScan, memoryDb } from './test-utils.js';

// Formats (GN7): a job keeps the sizes its brief asked for, only when it asked for more than one
// (`jobs.formats`, migration 0023_formats), and reports them as `Job.formats`. Any other job's
// shape is what it always was.

const NOW = Date.parse('2026-10-25T10:00:00.000Z');
const opened: StudioDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const clock = fakeClock('2026-10-25T10:00:00.000Z');
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const job = jobs.upsertFromScan(makeScan('Pinewood', '97 Window Ad')).job;
  return { db, jobs, job, clock };
}

describe('JobRepository.setFormats', () => {
  it('gives a job with two sizes its formats, the main one first, and says it changed', () => {
    const { jobs, job } = setup();
    const result = jobs.setFormats(job.id, ['1080x1920', '1080x1080']);
    expect(result.changed).toBe(true);
    expect(result.job.formats).toEqual([
      { id: '9x16', label: '9:16', width: 1080, height: 1920, previewPath: 'preview/index.html' },
      {
        id: '1x1',
        label: '1:1',
        width: 1080,
        height: 1080,
        previewPath: 'preview/1x1/index.html',
      },
    ]);
    expect(jobSchema.safeParse(result.job).success).toBe(true);
    expect(jobs.get(job.id)?.formats).toEqual(result.job.formats);
    expect(jobs.getAll().find((one) => one.id === job.id)?.formats).toEqual(result.job.formats);
    expect(jobs.getByRelPath(job.relPath)?.formats).toEqual(result.job.formats);
  });

  it('leaves every other job without the key: no formats, one format, a repeat, nothing', () => {
    const { jobs, job } = setup();
    expect(jobs.get(job.id)).not.toHaveProperty('formats');
    for (const canvases of [null, undefined, [], ['1080x1920'], ['1080x1920', '1080x1920']]) {
      const result = jobs.setFormats(job.id, canvases);
      expect(result.changed).toBe(false);
      expect(result.job).not.toHaveProperty('formats');
    }
  });

  it('says it did not change when the same sizes are set again, and does not move updatedAt', () => {
    const { jobs, job, clock } = setup();
    jobs.setFormats(job.id, ['1080x1920', '1080x1080']);
    const before = jobs.get(job.id);
    clock.tick(60_000);
    const again = jobs.setFormats(job.id, ['1080x1920', '1080x1080']);
    expect(again.changed).toBe(false);
    expect(again.job.updatedAt).toBe(before?.updatedAt);
  });

  it('takes the formats away again when the brief no longer asks for more than one', () => {
    const { jobs, job } = setup();
    jobs.setFormats(job.id, ['1080x1920', '1080x1080']);
    const cleared = jobs.setFormats(job.id, null);
    expect(cleared.changed).toBe(true);
    expect(cleared.job).not.toHaveProperty('formats');
    expect(jobs.get(job.id)).not.toHaveProperty('formats');
  });

  it('changes the main format when the order changes', () => {
    const { jobs, job } = setup();
    jobs.setFormats(job.id, ['1080x1920', '1080x1080']);
    const swapped = jobs.setFormats(job.id, ['1080x1080', '1080x1920']);
    expect(swapped.changed).toBe(true);
    expect(swapped.job.formats?.map((format) => format.id)).toEqual(['1x1', '9x16']);
    expect(swapped.job.formats?.map((format) => format.previewPath)).toEqual([
      'preview/index.html',
      'preview/9x16/index.html',
    ]);
  });

  it('throws for a job that is not there', () => {
    const { jobs } = setup();
    expect(() => jobs.setFormats('nope', ['1080x1920', '1080x1080'])).toThrow(JobNotFoundError);
  });

  it('keeps the formats through the job’s whole life: every transition writes them back', () => {
    const { jobs, job } = setup();
    jobs.setFormats(job.id, ['1080x1920', '1080x1080']);
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'START' });
    const output = {
      fileName: 'Pinewood/97 Window Ad.mp4',
      durationSec: 35,
      width: 1080,
      height: 1920,
      sizeBytes: 10,
      outputs: [
        { format: '9x16', fileName: 'Pinewood/97 Window Ad.mp4', bytes: 10 },
        { format: '1x1', fileName: 'Pinewood/97 Window Ad (1x1).mp4', bytes: 8 },
      ],
    };
    const ready = jobs.applyTransition(job.id, { type: 'SUCCEED', output });
    expect(ready.formats?.map((format) => format.id)).toEqual(['9x16', '1x1']);
    // The output with its files is stored and read back whole.
    expect(jobs.get(job.id)?.output).toEqual(output);
    expect(jobSchema.safeParse(jobs.get(job.id)).success).toBe(true);
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-migration-'));
  dirs.push(dir);
  return dir;
}

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

describe('migration 0023_formats', () => {
  it('is in the journal, right after the generated videos', () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    expect(tags.indexOf('0023_formats')).toBe(tags.indexOf('0022_generate') + 1);
  });

  it('adds jobs.formats as a nullable column, and no job that was there has formats', () => {
    const path = join(tempDir(), 'engine.db');
    const before = openDatabase(path, { migrationsFolder: folderWithFirst(23) });
    opened.push(before);
    before.sqlite
      .prepare(
        `insert into jobs (id, client, name, rel_path, rel_key, state, inputs, size_bytes,
           footage_seconds, added_at, updated_at, last_change_at, settled_at)
         values ('old-job', 'Northwind Bakery', 'old-job', 'old-job', 'old-job', 'ready',
           '{"video":1,"audio":0,"image":0,"doc":0}', 1000, 10, ?, ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW, NOW);
    expect(
      (before.sqlite.prepare('pragma table_info(jobs)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
    ).not.toContain('formats');
    before.close();

    const after = openDatabase(path);
    opened.push(after);
    const column = (
      after.sqlite.prepare('pragma table_info(jobs)').all() as {
        name: string;
        notnull: number;
        type: string;
        dflt_value: string | null;
      }[]
    ).find((one) => one.name === 'formats');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const job = new JobRepository(after, { clock: fakeClock('2026-10-25T10:00:00.000Z') }).get(
      'old-job',
    );
    expect(job?.id).toBe('old-job');
    expect(job).not.toHaveProperty('formats');
  });
});
