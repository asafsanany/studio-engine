import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureEditDir, JOB_FOLDER_GONE, JobStops } from './edit-dir.js';

let inbox: string;

beforeEach(async () => {
  inbox = await mkdtemp(join(tmpdir(), 'edit-dir-'));
});
afterEach(() => rm(inbox, { recursive: true, force: true }));

describe('ensureEditDir', () => {
  it('makes edit/ in a job folder that has none', async () => {
    const jobDir = join(inbox, 'Client', 'Job');
    await mkdir(jobDir, { recursive: true });
    expect(await ensureEditDir(jobDir)).toBe(join(jobDir, 'edit'));
    expect(existsSync(join(jobDir, 'edit'))).toBe(true);
  });

  it('leaves an edit/ that is there as it is', async () => {
    const jobDir = join(inbox, 'Client', 'Job');
    await mkdir(join(jobDir, 'edit'), { recursive: true });
    await writeFile(join(jobDir, 'edit', 'project.md'), '# Job\n');
    await ensureEditDir(jobDir);
    expect(existsSync(join(jobDir, 'edit', 'project.md'))).toBe(true);
  });

  it('does not make the job folder when it is gone (a deleted job must not come back)', async () => {
    const jobDir = join(inbox, 'Client', 'Job');
    await expect(ensureEditDir(jobDir)).rejects.toThrow(JOB_FOLDER_GONE);
    expect(existsSync(jobDir)).toBe(false);
    expect(existsSync(join(inbox, 'Client'))).toBe(false);
  });
});

describe('JobStops', () => {
  it('gives a job the same stop until the job is forgotten', () => {
    const stops = new JobStops();
    const first = stops.of('j1');
    expect(stops.of('j1')).toBe(first);
    expect(stops.of('j2')).not.toBe(first);
    expect(first.aborted).toBe(false);
  });

  it('aborts what was taken when the job is forgotten, and no other job', () => {
    const stops = new JobStops();
    const taken = stops.of('j1');
    const other = stops.of('j2');
    stops.forget('j1');
    expect(taken.aborted).toBe(true);
    expect(taken.reason).toMatchObject({ message: JOB_FOLDER_GONE });
    expect(other.aborted).toBe(false);
  });

  it('gives a job asked about after it was forgotten a fresh stop', () => {
    const stops = new JobStops();
    const before = stops.of('j1');
    stops.forget('j1');
    const after = stops.of('j1');
    expect(after).not.toBe(before);
    expect(after.aborted).toBe(false);
    // Forgetting a job nobody asked about is nothing.
    expect(() => stops.forget('never')).not.toThrow();
  });
});
