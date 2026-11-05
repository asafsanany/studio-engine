// CVP-197: Show archived on a client's page. It is the Jobs page's switch. The header's count
// keeps counting archived jobs (it is the number of jobs the client has had); off, a quiet line
// under the list says how many are archived and turns the switch on; on, the archived rows join the
// list, faded, and the line reads "Hide archived".

import type { Job } from '@studio/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLIENTS_KEY } from '@/data/clients-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { createTestQueryClient, makeJob } from '@/data/test-utils';
import { CLIENT_BOARD_JOBS, clientRowsOf } from '@/features/clients/test-clients';
import { CLIENT_IDS } from '@/features/jobs/test-jobs';
import { renderApp } from '@/lib/test-router';
import { jobsUiStore } from '@/stores/jobs-ui';

const ARC = CLIENT_IDS['Arc Fitness'];

/** Two of Arc Fitness's jobs, archived, older than its three. */
const ARCHIVED_JOBS: readonly Job[] = [
  makeJob({
    id: 'arc-old-1',
    client: 'Arc Fitness',
    clientId: ARC,
    name: 'Old class schedule',
    relPath: 'Arc Fitness/Old class schedule',
    state: 'ready',
    placeInLine: null,
    updatedAt: '2026-09-01T10:00:00.000Z',
    addedAt: '2026-09-01T09:00:00.000Z',
    archivedAt: '2026-10-01T10:00:00.000Z',
  }),
  makeJob({
    id: 'arc-old-2',
    client: 'Arc Fitness',
    clientId: ARC,
    name: 'Old studio tour',
    relPath: 'Arc Fitness/Old studio tour',
    state: 'cancelled',
    placeInLine: null,
    updatedAt: '2026-09-02T10:00:00.000Z',
    addedAt: '2026-09-02T09:00:00.000Z',
    archivedAt: '2026-10-01T10:00:00.000Z',
  }),
];

const JOBS = [...CLIENT_BOARD_JOBS, ...ARCHIVED_JOBS];

async function arcPage(jobs: readonly Job[] = JOBS) {
  const client = createTestQueryClient();
  client.setQueryData(JOBS_KEY, jobs);
  // The server counts every job of the client, archived or not.
  client.setQueryData(CLIENTS_KEY, clientRowsOf(jobs));
  const markup = await renderApp(`/clients/${ARC}`, client);
  return markup.slice(markup.indexOf('<main'));
}

const rowIds = (markup: string) => [...markup.matchAll(/data-job-id="([^"]+)"/g)].map((m) => m[1]);

/** The archive line under the list, as text, or `undefined`. */
const lineOf = (markup: string) =>
  markup
    .match(/<button[^>]*data-slot="button"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g)
    ?.map((button) => button.replace(/<[^>]+>/g, ''))
    .find((text) => /archived/i.test(text));

beforeAll(() => {
  // zustand's server render reads the store's initial state; point it at the current one.
  jobsUiStore.getInitialState = () => jobsUiStore.getState();
});
afterEach(() => {
  jobsUiStore.getState().setShowArchived(false);
});

describe("a client's page: Show archived off", () => {
  it('lists only the jobs that are not archived', async () => {
    expect(rowIds(await arcPage())).toEqual(['j5', 'j2', 'j10']);
  });

  it('still counts the archived ones in the header: 5 jobs', async () => {
    expect(await arcPage()).toContain('5 jobs · last job');
  });

  it('says how many are archived under the list, and offers to show them', async () => {
    const markup = await arcPage();
    expect(lineOf(markup)).toBe('2 archived · Show');
    expect(markup.indexOf('</ul>')).toBeLessThan(markup.indexOf('2 archived · Show'));
  });

  it('says nothing for a client with nothing archived', async () => {
    expect(lineOf(await arcPage(CLIENT_BOARD_JOBS))).toBeUndefined();
  });
});

describe("a client's page: Show archived on", () => {
  it('adds the archived rows to the list, faded, with the box mark', async () => {
    jobsUiStore.getState().setShowArchived(true);
    const markup = await arcPage();
    expect(rowIds(markup)).toEqual(['j5', 'j2', 'j10', 'arc-old-2', 'arc-old-1']);
    expect(markup.match(/data-archived=""/g)).toHaveLength(2);
    expect(markup.match(/aria-label="Archived"/g)).toHaveLength(2);
  });

  it('still counts 5 jobs in the header', async () => {
    jobsUiStore.getState().setShowArchived(true);
    expect(await arcPage()).toContain('5 jobs · last job');
  });

  it('reads “Hide archived” under the list', async () => {
    jobsUiStore.getState().setShowArchived(true);
    expect(lineOf(await arcPage())).toBe('Hide archived');
  });
});
