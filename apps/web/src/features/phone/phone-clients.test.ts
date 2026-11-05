import type { Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { lastUpdatedOrder } from '@/features/jobs/sorting';
import {
  clientArchivedButton,
  clientArchivedLead,
  clientArchivedLine,
  clientJobs,
  inSentence,
} from './phone-clients';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const job = (id: string, overrides: Partial<Job>) =>
  makeJob({ id, clientId: 'rgm', client: 'RGM', name: `Job ${id}`, state: 'ready', ...overrides });

const ARCHIVED = ago(500);
const JOBS = lastUpdatedOrder([
  job('a', { updatedAt: ago(3) }),
  job('b', { updatedAt: ago(30), state: 'failed' }),
  job('c', { updatedAt: ago(600), archivedAt: ARCHIVED }),
  job('x', { clientId: 'acme', client: 'Acme', updatedAt: ago(1) }),
]);

const ids = (jobs: readonly Job[]) => jobs.map((j) => j.id);

describe('clientJobs', () => {
  it('lists only the client’s jobs, last updated first, archived ones left out', () => {
    expect(ids(clientJobs(JOBS, 'rgm', false))).toEqual(['a', 'b']);
  });

  it('brings the archived ones in with Show archived on', () => {
    expect(ids(clientJobs(JOBS, 'rgm', true))).toEqual(['a', 'b', 'c']);
  });

  it('is empty for a client with no job', () => {
    expect(clientJobs(JOBS, 'nobody', true)).toEqual([]);
  });
});

describe('clientArchivedLine', () => {
  it('counts the client’s archived jobs, and only theirs', () => {
    expect(clientArchivedLine(JOBS, 'rgm', false)).toEqual({ count: 1, shown: false });
    expect(clientArchivedLine(JOBS, 'rgm', true)).toEqual({ count: 1, shown: true });
  });

  it('is none for a client with nothing archived', () => {
    expect(clientArchivedLine(JOBS, 'acme', false)).toBeNull();
  });

  it('says "N archived · Show", and "N archived shown · Hide archived" while they are shown', () => {
    const hidden = { count: 2, shown: false };
    expect(clientArchivedLead(hidden)).toBe('2 archived ·');
    expect(clientArchivedButton(hidden)).toBe('Show');
    const shown = { count: 2, shown: true };
    expect(clientArchivedLead(shown)).toBe('2 archived shown ·');
    expect(clientArchivedButton(shown)).toBe('Hide archived');
  });
});

describe('inSentence', () => {
  it('lower-cases the first letter of the capitalised forms, and leaves the others', () => {
    expect(inSentence('Just now')).toBe('just now');
    expect(inSentence('Yesterday')).toBe('yesterday');
    expect(inSentence('3 min ago')).toBe('3 min ago');
    expect(inSentence('2 days ago')).toBe('2 days ago');
    expect(inSentence('')).toBe('');
  });
});
