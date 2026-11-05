import { JOB_STATES, type Job } from '@studio/shared';
import { History } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { clearSectionRequest, pendingSectionRequest } from '@/features/job-sheet/job-sheet-section';
import { rowMenuEntries } from './row-menu';

// "Versions…" in a job's menu (Plane VE2): it opens the job sheet at its Versions part.

const idle = { run: vi.fn(), busy: false };
const PREVIEW = { durationSec: 28.4, width: 1080, height: 1920 };

const idsOf = (entries: ReturnType<typeof rowMenuEntries>) => entries.map((entry) => entry.id);

afterEach(clearSectionRequest);

describe('rowMenuEntries: Versions…', () => {
  it('follows Review… for a job in Review', () => {
    const job = makeJob({ state: 'review', preview: PREVIEW });
    const entries = rowMenuEntries(job, idle, null, undefined, undefined, true, true);
    expect(idsOf(entries).slice(0, 3)).toEqual(['review', 'versions', 'review-separator']);
    const versions = entries[1];
    expect(versions?.type === 'item' && versions.label).toBe('Versions…');
    expect(versions?.type === 'item' && versions.icon).toBe(History);
    expect(versions?.type === 'item' && versions.disabled).toBeFalsy();
  });

  it('follows View preview… for a job that left Review with a preview', () => {
    const job = makeJob({ state: 'ready', preview: PREVIEW });
    const entries = rowMenuEntries(job, idle, null, undefined, undefined, true, true);
    expect(idsOf(entries).slice(0, 2)).toEqual(['view-preview', 'versions']);
  });

  it('asks the sheet for the job’s Versions part when chosen, and sends nothing', () => {
    const job = makeJob({ id: 'job-versions', state: 'review', preview: PREVIEW });
    const versions = rowMenuEntries(job, idle, null, undefined, undefined, true, true).find(
      (entry) => entry.id === 'versions',
    );
    if (versions?.type !== 'item') throw new Error('no Versions… item');
    versions.onSelect();
    expect(pendingSectionRequest()).toMatchObject({ jobId: 'job-versions', section: 'versions' });
    expect(idle.run).not.toHaveBeenCalled();
  });

  it('is left out when the job sheet is off (the default), and for a job with nothing to look at', () => {
    const review = makeJob({ state: 'review', preview: PREVIEW });
    expect(idsOf(rowMenuEntries(review, idle))).not.toContain('versions');
    for (const state of ['arriving', 'queued', 'held', 'editing'] as const) {
      const job = makeJob({ state, preview: null });
      const entries = rowMenuEntries(job, idle, null, undefined, undefined, true, true);
      expect(idsOf(entries), state).not.toContain('versions');
    }
  });

  it('is left out for a video whose folder was deleted', () => {
    const job = { ...makeJob({ state: 'ready', preview: PREVIEW }), folderDeleted: true } as Job;
    for (const admin of [true, false]) {
      const entries = rowMenuEntries(job, idle, null, undefined, undefined, admin, true);
      expect(idsOf(entries)).not.toContain('versions');
    }
  });

  it('ends no menu with a separator, in any state', () => {
    for (const state of JOB_STATES) {
      const job = makeJob({ state, failedAt: 8, error: 'boom', preview: PREVIEW });
      const entries = rowMenuEntries(job, idle, null, undefined, undefined, true, true);
      expect(entries.at(-1)?.type, state).not.toBe('separator');
    }
  });
});
