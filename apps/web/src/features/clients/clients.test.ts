import { describe, expect, it } from 'vitest';
import { CLIENT_IDS } from '../jobs/test-jobs';
import {
  CLIENT_SORT_VALUE,
  clientCountText,
  clientsBodyState,
  clientsFooterText,
  filterClients,
  findClient,
  jobCountText,
  summarizeClients,
} from './clients';
import {
  CLIENT_BOARD_ROWS,
  CLIENT_DEFAULT_ORDER,
  makeClientRow,
  makeEmptyClientRow,
} from './test-clients';

const names = (rows = CLIENT_BOARD_ROWS) => summarizeClients(rows).map((client) => client.name);

describe('summarizeClients: the rows', () => {
  it('lists each client once, with its number of jobs', () => {
    const clients = summarizeClients(CLIENT_BOARD_ROWS);
    expect(clients).toHaveLength(7);
    expect(Object.fromEntries(clients.map((c) => [c.name, c.jobCount]))).toEqual({
      'מאפיית הצפון': 3,
      'Noa Ceramics': 1,
      'Arc Fitness': 3,
      'Lumen Yoga': 1,
      'מרפאת מירה': 2,
      'טל נכסים': 2,
      'Kova Coffee': 2,
    });
  });

  it('takes the name, the id and the last job from the row', () => {
    const [client] = summarizeClients([
      makeClientRow({
        clientId: 'ad9dd7b1acf3',
        client: 'Café Mocha'.normalize('NFD'),
        jobs: 2,
        lastJobAt: '2026-10-20T11:00:00.000Z',
      }),
    ]);
    expect(client).toEqual({
      clientId: 'ad9dd7b1acf3',
      name: 'Café Mocha'.normalize('NFD'),
      initials: expect.any(String),
      jobCount: 2,
      lastJobAt: '2026-10-20T11:00:00.000Z',
    });
  });

  it('keeps two clients apart when only their ids differ', () => {
    const rows = [
      makeClientRow({ clientId: 'aaaaaaaaaaaa', client: 'Acme' }),
      makeClientRow({ clientId: 'bbbbbbbbbbbb', client: 'Acme' }),
    ];
    expect(summarizeClients(rows)).toHaveLength(2);
  });

  it('is empty for no rows', () => {
    expect(summarizeClients([])).toEqual([]);
  });

  it('gives the initials the Jobs table shows', () => {
    const initials = Object.fromEntries(
      summarizeClients(CLIENT_BOARD_ROWS).map((c) => [c.name, c.initials]),
    );
    expect(initials).toMatchObject({
      'Arc Fitness': 'AF',
      'Kova Coffee': 'KC',
      'מאפיית הצפון': 'מה',
      'טל נכסים': 'טנ',
    });
  });

  it('carries the id the URL uses', () => {
    const arc = summarizeClients(CLIENT_BOARD_ROWS).find((c) => c.name === 'Arc Fitness');
    expect(arc?.clientId).toBe(CLIENT_IDS['Arc Fitness']);
  });

  it('keeps a client with no jobs: 0 jobs and no last job', () => {
    const [client] = summarizeClients([makeEmptyClientRow({ client: 'Fresh Co' })]);
    expect(client).toMatchObject({ name: 'Fresh Co', jobCount: 0, lastJobAt: null });
  });
});

describe('summarizeClients: order', () => {
  it('lists the board clients by last job, newest first', () => {
    expect(names()).toEqual([...CLIENT_DEFAULT_ORDER]);
  });

  it('does not depend on the order of the rows', () => {
    expect(names([...CLIENT_BOARD_ROWS].reverse())).toEqual([...CLIENT_DEFAULT_ORDER]);
  });

  it('breaks a tie by name', () => {
    const at = '2026-10-20T10:00:00.000Z';
    const rows = [
      makeClientRow({ clientId: 'z', client: 'Zed', lastJobAt: at }),
      makeClientRow({ clientId: 'a', client: 'Abe', lastJobAt: at }),
    ];
    expect(names(rows)).toEqual(['Abe', 'Zed']);
  });

  it('puts the clients with no jobs after those that have, by name', () => {
    const rows = [
      makeEmptyClientRow({ clientId: 'z', client: 'Zed' }),
      makeClientRow({ clientId: 'o', client: 'Old', lastJobAt: '2020-01-01T00:00:00.000Z' }),
      makeEmptyClientRow({ clientId: 'a', client: 'Abe' }),
    ];
    expect(names(rows)).toEqual(['Old', 'Abe', 'Zed']);
  });
});

describe('findClient', () => {
  it('finds a client by id, and only a client the list holds', () => {
    const clients = summarizeClients(CLIENT_BOARD_ROWS);
    expect(findClient(clients, CLIENT_IDS['Kova Coffee'])?.name).toBe('Kova Coffee');
    expect(findClient(clients, 'nosuchclient')).toBeUndefined();
    expect(findClient([], CLIENT_IDS['Kova Coffee'])).toBeUndefined();
  });

  it('finds a client that has no jobs', () => {
    const clients = summarizeClients([makeEmptyClientRow({ clientId: 'e', client: 'Fresh Co' })]);
    expect(findClient(clients, 'e')).toMatchObject({ name: 'Fresh Co', jobCount: 0 });
  });
});

describe('filterClients', () => {
  const clients = summarizeClients(CLIENT_BOARD_ROWS);
  const found = (search: string) => filterClients(clients, search).map((c) => c.name);

  it('keeps everyone for an empty or blank search', () => {
    expect(found('')).toHaveLength(7);
    expect(found('   ')).toHaveLength(7);
  });

  it('matches part of a name, ignoring case', () => {
    expect(found('arc')).toEqual(['Arc Fitness']);
    expect(found('FIT')).toEqual(['Arc Fitness']);
    expect(found('m')).toEqual(['Noa Ceramics', 'Lumen Yoga']);
  });

  it('wants every word of the search', () => {
    expect(found('kova coffee')).toEqual(['Kova Coffee']);
    expect(found('kova yoga')).toEqual([]);
  });

  it('finds Hebrew names, with or without vowel points', () => {
    expect(found('מירה')).toEqual(['מרפאת מירה']);
    expect(found('מָאפיית')).toEqual(['מאפיית הצפון']);
  });

  it('does not search the jobs, only the name', () => {
    expect(found('kiln')).toEqual([]);
  });

  it('matches a name typed composed against one stored decomposed', () => {
    const decomposed = summarizeClients([makeClientRow({ client: 'Café Mocha'.normalize('NFD') })]);
    expect(filterClients(decomposed, 'café'.normalize('NFC'))).toHaveLength(1);
  });
});

describe('the sort values', () => {
  const [client] = summarizeClients([
    makeClientRow({ client: 'Acme', jobs: 2, lastJobAt: '2026-10-20T11:00:00.000Z' }),
  ]);
  const [empty] = summarizeClients([makeEmptyClientRow()]);

  it('are the name, the number of jobs and the last job in milliseconds', () => {
    if (!client) throw new Error('no client');
    expect(CLIENT_SORT_VALUE.client(client)).toBe('Acme');
    expect(CLIENT_SORT_VALUE.jobs(client)).toBe(2);
    expect(CLIENT_SORT_VALUE.last(client)).toBe(Date.parse('2026-10-20T11:00:00.000Z'));
  });

  it('put a client with no jobs below any job: 0 jobs, and a last job older than all', () => {
    if (!client || !empty) throw new Error('no client');
    expect(CLIENT_SORT_VALUE.jobs(empty)).toBe(0);
    expect(CLIENT_SORT_VALUE.last(empty)).toBeLessThan(CLIENT_SORT_VALUE.last(client) as number);
  });
});

describe('clientsBodyState', () => {
  it('is loading until the first answer, or unreachable when it failed', () => {
    expect(clientsBodyState({ clients: undefined, failed: false, matching: 0 })).toBe('loading');
    expect(clientsBodyState({ clients: undefined, failed: true, matching: 0 })).toBe('unreachable');
  });

  it('keeps a list that has arrived over a later failure', () => {
    expect(clientsBodyState({ clients: CLIENT_BOARD_ROWS, failed: true, matching: 7 })).toBe(
      'rows',
    );
  });

  it('is empty for no client folder at all, whatever the search says', () => {
    expect(clientsBodyState({ clients: [], failed: false, matching: 0 })).toBe('empty');
  });

  it('is no-match when the search leaves none, and rows otherwise', () => {
    expect(clientsBodyState({ clients: CLIENT_BOARD_ROWS, failed: false, matching: 0 })).toBe(
      'no-match',
    );
    expect(clientsBodyState({ clients: CLIENT_BOARD_ROWS, failed: false, matching: 3 })).toBe(
      'rows',
    );
  });

  it('counts a client with no jobs as a client', () => {
    expect(clientsBodyState({ clients: [makeEmptyClientRow()], failed: false, matching: 1 })).toBe(
      'rows',
    );
  });
});

describe('texts', () => {
  it('says "1 client" but "0 / 2 clients"', () => {
    expect(clientCountText(1)).toBe('1 client');
    expect(clientCountText(0)).toBe('0 clients');
    expect(clientCountText(7)).toBe('7 clients');
  });

  it('says "N of M clients" while the search leaves some out', () => {
    expect(clientsFooterText(7, 7)).toBe('7 clients');
    expect(clientsFooterText(2, 7)).toBe('2 of 7 clients');
    expect(clientsFooterText(0, 7)).toBe('0 of 7 clients');
    expect(clientsFooterText(1, 1)).toBe('1 client');
  });

  it('says "1 job" but "3 jobs", and "0 jobs"', () => {
    expect(jobCountText(1)).toBe('1 job');
    expect(jobCountText(3)).toBe('3 jobs');
    expect(jobCountText(0)).toBe('0 jobs');
  });
});

describe('summarizeClients: the admin’s assignees (TM5)', () => {
  const rows = [
    makeClientRow({ clientId: 'aaaaaaaaaaaa', client: 'Arc Fitness' }),
    makeClientRow({ clientId: 'bbbbbbbbbbbb', client: 'Kova Coffee' }),
  ];

  it('leaves assignedTo out without a lookup (an editor)', () => {
    for (const client of summarizeClients(rows)) expect(client).not.toHaveProperty('assignedTo');
  });

  it('puts the lookup’s names on each client; an empty list is a client for the admin alone', () => {
    const clients = summarizeClients(rows, (id) => (id === 'aaaaaaaaaaaa' ? ['Yael', 'Amit'] : []));
    expect(Object.fromEntries(clients.map((c) => [c.name, c.assignedTo]))).toEqual({
      'Arc Fitness': ['Yael', 'Amit'],
      'Kova Coffee': [],
    });
  });

  it('leaves it out while the team is not known (the lookup says undefined)', () => {
    for (const client of summarizeClients(rows, () => undefined)) {
      expect(client).not.toHaveProperty('assignedTo');
    }
  });
});
