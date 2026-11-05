import { afterEach, describe, expect, it } from 'vitest';
import { clientIdFor, seriesIdFor } from '../inbox/scan.js';
import { ClientStyleRepository } from './client-style-repository.js';
import type { StudioDb } from './database.js';
import { DeliveryRepository } from './delivery-repository.js';
import { ClientRenameConflictError, JobRepository } from './job-repository.js';
import { SeriesRepository } from './series-repository.js';
import { fakeClock, idFor, makeScan, memoryDb, rawRow } from './test-utils.js';

// JobRepository.renameClient: a client's new name is a new id for it, its jobs and its series, and
// every row about them follows.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const deliveries = new DeliveryRepository(db);
  const clientStyles = new ClientStyleRepository(db, { clock });
  const series = new SeriesRepository(db, { clock });
  const ad = jobs.upsertFromScan(makeScan('Pinewood', 'Ad 6')).job;
  const other = jobs.upsertFromScan(makeScan('LAKESHORE', 'Promo')).job;
  return { db, jobs, deliveries, clientStyles, series, ad, other };
}

/** Takes a job to ready with an export file named after its client. */
function finish(jobs: JobRepository, id: string, fileName: string) {
  jobs.applyTransition(id, { type: 'SETTLED' });
  jobs.applyTransition(id, { type: 'START' });
  return jobs.applyTransition(id, {
    type: 'SUCCEED',
    output: { fileName, durationSec: 30, width: 1080, height: 1920, sizeBytes: 5 },
  });
}

describe('JobRepository.renameClient', () => {
  it('moves the client’s jobs to the new name, path and id and leaves the others', () => {
    const { jobs, ad, other } = setup();

    const result = jobs.renameClient('Pinewood', 'Pinewood Labs');

    const newId = idFor('Pinewood Labs/Ad 6');
    expect(result.movedIds).toEqual([{ from: ad.id, to: newId }]);
    expect(result.jobs).toMatchObject([
      {
        id: newId,
        client: 'Pinewood Labs',
        clientId: clientIdFor('Pinewood Labs'),
        name: 'Ad 6',
        relPath: 'Pinewood Labs/Ad 6',
        state: ad.state,
        updatedAt: ad.updatedAt,
      },
    ]);
    expect(jobs.get(ad.id)).toBeNull();
    expect(jobs.getByRelPath('Pinewood Labs/Ad 6')?.id).toBe(newId);
    expect(jobs.get(other.id)).toEqual(other);
  });

  it('rewrites export file names that start with the client’s folder', () => {
    const { jobs, ad } = setup();
    finish(jobs, ad.id, 'Pinewood/Ad 6.mp4');

    const [moved] = jobs.renameClient('Pinewood', 'Pinewood Labs').jobs;

    expect(moved?.output?.fileName).toBe('Pinewood Labs/Ad 6.mp4');
  });

  it('moves the deliveries, the style and the series, and the rows about the jobs', () => {
    const { db, jobs, deliveries, clientStyles, series, ad } = setup();
    const ready = finish(jobs, ad.id, 'Pinewood/Ad 6.mp4');
    deliveries.record({
      jobId: ready.id,
      clientId: ready.clientId,
      client: 'Pinewood',
      name: 'Ad 6',
      relPath: 'Pinewood/Ad 6',
      deliveredAt: 1,
      price: 40,
      currency: 'ILS',
      reviewSec: 0,
    });
    // A delivered video whose folder is gone: still the client's.
    deliveries.record({
      jobId: idFor('Pinewood/Ad 1'),
      clientId: clientIdFor('Pinewood'),
      client: 'Pinewood',
      name: 'Ad 1',
      relPath: 'Pinewood/Ad 1',
      deliveredAt: 1,
      price: 40,
      currency: 'ILS',
      reviewSec: 0,
    });
    clientStyles.upsert({
      clientId: clientIdFor('Pinewood'),
      client: 'Pinewood',
      state: 'ready',
      sourceJobId: ad.id,
    });
    const started = series.create({
      clientId: clientIdFor('Pinewood'),
      client: 'Pinewood',
      name: 'Ad',
      formatJobId: ad.id,
      formatJob: 'Ad 6',
      state: 'ready',
    });
    jobs.setSeries(ad.id, { seriesId: started.id, episode: 6, pinned: false });
    db.sqlite
      .prepare(
        "insert into review_notes (id, job_id, at_sec, kind, created_at) values ('n1', ?, 1.5, 'text', 1)",
      )
      .run(ad.id);

    const result = jobs.renameClient('Pinewood', 'Pinewood Labs');

    const toId = clientIdFor('Pinewood Labs');
    const newJobId = idFor('Pinewood Labs/Ad 6');
    const newSeriesId = seriesIdFor(toId, 'Ad');
    expect(result.deliveries).toBe(2);
    expect(result.movedSeries).toEqual([{ from: started.id, to: newSeriesId }]);
    expect(rawRow(db, 'deliveries', `job_id = '${newJobId}'`)).toMatchObject([
      { client_id: toId, client: 'Pinewood Labs', rel_path: 'Pinewood Labs/Ad 6', price: 40 },
    ]);
    expect(rawRow(db, 'deliveries', `job_id = '${idFor('Pinewood Labs/Ad 1')}'`)).toMatchObject([
      { client_id: toId, client: 'Pinewood Labs', rel_path: 'Pinewood Labs/Ad 1' },
    ]);
    expect(rawRow(db, 'deliveries', `client_id = '${clientIdFor('Pinewood')}'`)).toEqual([]);
    expect(clientStyles.get(clientIdFor('Pinewood'))).toBeNull();
    expect(clientStyles.get(toId)).toMatchObject({
      client: 'Pinewood Labs',
      state: 'ready',
      sourceJobId: newJobId,
    });
    expect(series.get(started.id)).toBeNull();
    expect(series.get(newSeriesId)).toMatchObject({
      clientId: toId,
      client: 'Pinewood Labs',
      name: 'Ad',
      formatJobId: newJobId,
    });
    expect(jobs.get(newJobId)).toMatchObject({ seriesId: newSeriesId, episode: 6 });
    expect(rawRow(db, 'review_notes', `job_id = '${newJobId}'`)).toHaveLength(1);
  });

  it('refuses a name the engine knows a client by, and changes nothing', () => {
    const { jobs, ad, other } = setup();

    expect(() => jobs.renameClient('Pinewood', 'LAKESHORE')).toThrow(ClientRenameConflictError);

    expect(jobs.get(ad.id)).toEqual(ad);
    expect(jobs.get(other.id)).toEqual(other);
  });

  it('refuses a name with a stored style left from an earlier client', () => {
    const { jobs, clientStyles, ad } = setup();
    clientStyles.upsert({ clientId: clientIdFor('Old'), client: 'Old', state: 'ready' });

    expect(() => jobs.renameClient('Pinewood', 'Old')).toThrow(ClientRenameConflictError);
    expect(jobs.get(ad.id)).toEqual(ad);
  });

  it('does nothing for the same name', () => {
    const { jobs, ad } = setup();

    expect(jobs.renameClient('Pinewood', 'Pinewood')).toMatchObject({ jobs: [], movedIds: [] });
    expect(jobs.get(ad.id)).toEqual(ad);
  });
});
