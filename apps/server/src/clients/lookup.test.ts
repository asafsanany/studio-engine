import { afterEach, describe, expect, it } from 'vitest';
import { ClientStyleRepository, JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { noopEventBus } from '../events/bus.js';
import { clientIdFor } from '../inbox/scan.js';
import { ClientFolders } from './client-folders.js';
import { findClient } from './lookup.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

function setup() {
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db);
  const clientStyles = new ClientStyleRepository(db);
  const folders = new ClientFolders(noopEventBus);
  return { jobs, clientStyles, folders, sources: { jobs, clientStyles, folders } };
}

describe('findClient', () => {
  it('finds a client by the id of its folder name once it has a job', () => {
    const { jobs, sources } = setup();
    jobs.upsertFromScan(makeScan('Arc Fitness', 'Spring'));
    jobs.upsertFromScan(makeScan('Kova Coffee', 'Menu'));

    expect(findClient(clientIdFor('Arc Fitness'), sources)).toBe('Arc Fitness');
    expect(findClient(clientIdFor('Kova Coffee'), sources)).toBe('Kova Coffee');
  });

  it('does not know a client nobody has a job or a style for, nor a made-up id', () => {
    const { jobs, sources } = setup();
    jobs.upsertFromScan(makeScan('Arc Fitness', 'Spring'));

    expect(findClient(clientIdFor('Nobody'), sources)).toBeNull();
    expect(findClient('000000000000', sources)).toBeNull();
    expect(findClient('', sources)).toBeNull();
  });

  it('finds a client folder that has no job and no style', () => {
    const { folders, sources } = setup();
    folders.add('Empty Client');
    folders.add('מאפיית הצפון');

    expect(findClient(clientIdFor('Empty Client'), sources)).toBe('Empty Client');
    expect(findClient(clientIdFor('מאפיית הצפון'), sources)).toBe('מאפיית הצפון');
    expect(findClient(clientIdFor('Nobody'), sources)).toBeNull();
  });

  it('forgets a client folder that is gone, unless a job or a style still names it', () => {
    const { jobs, clientStyles, folders, sources } = setup();
    folders.add('Empty Client');
    folders.add('Arc Fitness');
    folders.add('Kova Coffee');
    jobs.upsertFromScan(makeScan('Arc Fitness', 'Spring'));
    clientStyles.upsert({
      clientId: clientIdFor('Kova Coffee'),
      client: 'Kova Coffee',
      state: 'ready',
      version: 1,
    });

    for (const name of ['Empty Client', 'Arc Fitness', 'Kova Coffee']) folders.remove(name);

    expect(findClient(clientIdFor('Empty Client'), sources)).toBeNull();
    expect(findClient(clientIdFor('Arc Fitness'), sources)).toBe('Arc Fitness');
    expect(findClient(clientIdFor('Kova Coffee'), sources)).toBe('Kova Coffee');
  });

  it('works without a list of client folders', () => {
    const { jobs, clientStyles } = setup();
    jobs.upsertFromScan(makeScan('Arc Fitness', 'Spring'));

    expect(findClient(clientIdFor('Arc Fitness'), { jobs, clientStyles })).toBe('Arc Fitness');
    expect(findClient(clientIdFor('Nobody'), { jobs, clientStyles })).toBeNull();
  });

  it('knows a client by its stored style when its last job is gone', () => {
    const { jobs, clientStyles, sources } = setup();
    const { job } = jobs.upsertFromScan(makeScan('Arc Fitness', 'Spring'));
    clientStyles.upsert({
      clientId: clientIdFor('Arc Fitness'),
      client: 'Arc Fitness',
      state: 'ready',
      version: 1,
    });
    jobs.remove(job.id);

    expect(findClient(clientIdFor('Arc Fitness'), sources)).toBe('Arc Fitness');
  });

  it('prefers the spelling of the jobs over the stored one, and finds either spelling of the name', () => {
    const { jobs, clientStyles, sources } = setup();
    const nfc = 'Café Müller';
    const nfd = nfc.normalize('NFD');
    jobs.upsertFromScan(makeScan(nfd, 'Spring'));
    clientStyles.upsert({ clientId: clientIdFor(nfc), client: nfc, state: 'ready', version: 1 });

    // The id is the same for both spellings; the name is the one the scan listed.
    expect(clientIdFor(nfd)).toBe(clientIdFor(nfc));
    expect(findClient(clientIdFor(nfc), sources)).toBe(nfd);
  });
});
