import type { Job, JobReel } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJobDelivery } from '@/data/test-utils';
import { detailRows, phoneDetailRows } from './sheet-details';
import {
  clientPageText,
  instagramRow,
  noReelText,
  ON_INSTAGRAM_LABEL,
  reelNumbersText,
  type SheetInstagram,
} from './sheet-instagram';
import { jobSheetJobs, jobSheetNow } from './test-fixtures';

const UTC = 'UTC';

const REEL: JobReel = {
  shortcode: 'DAbc123',
  url: 'https://www.instagram.com/reel/DAbc123/',
  postedAt: '2026-10-20T09:30:00.000Z',
  plays: 27_500,
  likes: 1_640,
  comments: 71,
  shares: 820,
};

/** A delivered job a reel is linked to (Uploaded): posted Tue 20 Oct. */
const uploaded: Job = {
  ...jobSheetJobs.delivered,
  delivery: makeJobDelivery({ uploadedAt: '2026-10-20T09:30:00.000Z' }),
};
/** A delivered job no reel is linked to. */
const delivered: Job = jobSheetJobs.delivered;
const now = jobSheetNow.delivered;

const linked = (reel: JobReel | null = REEL): SheetInstagram => ({ kind: 'reel', reel });
const NONE: SheetInstagram = { kind: 'none' };

describe('reelNumbersText', () => {
  it('writes plays the short way and the rest in full, as the board has them', () => {
    expect(reelNumbersText(REEL)).toBe('27.5K plays · 1,640 likes · 71 comments · 820 shares');
  });

  it('leaves out the shares a scan could not read', () => {
    expect(reelNumbersText({ ...REEL, shares: null })).toBe(
      '27.5K plays · 1,640 likes · 71 comments',
    );
  });

  it('keeps zero shares, which the scan did read', () => {
    expect(reelNumbersText({ ...REEL, shares: 0 })).toBe(
      '27.5K plays · 1,640 likes · 71 comments · 0 shares',
    );
  });

  it('uses the singular for one', () => {
    expect(reelNumbersText({ ...REEL, plays: 1, likes: 1, comments: 1, shares: 1 })).toBe(
      '1 play · 1 like · 1 comment · 1 share',
    );
  });

  it('writes plays under a thousand as they are', () => {
    expect(reelNumbersText({ ...REEL, plays: 980 })).toMatch(/^980 plays · /);
  });
});

describe('the sentence of a delivered job with no reel', () => {
  it('names the client’s page, with the board’s curly apostrophe', () => {
    expect(clientPageText('Falcon FPV')).toBe('Falcon FPV’s page');
    expect(noReelText('Falcon FPV')).toBe('No reel linked yet. Link it from Falcon FPV’s page.');
  });
});

describe('instagramRow: a job a reel is linked to', () => {
  it('has the numbers, with the day it was posted and who linked it under them', () => {
    expect(instagramRow(uploaded, linked(), UTC)).toEqual({
      label: 'On Instagram',
      value: '27.5K plays · 1,640 likes · 71 comments · 820 shares',
      sub: 'Posted Tue 20 Oct · linked by you',
      muted: false,
      instagram: { kind: 'reel', url: 'https://www.instagram.com/reel/DAbc123/' },
    });
  });

  it('shows a dash for the numbers while they are on their way, and the reel the job knows', () => {
    const job: Job = {
      ...uploaded,
      delivery: makeJobDelivery({
        uploadedAt: '2026-10-20T09:30:00.000Z',
        reelUrl: 'https://www.instagram.com/reel/KnownByJob/',
      }),
    };
    const row = instagramRow(job, linked(null), UTC);
    expect(row?.value).toBe('—');
    expect(row?.sub).toBe('Posted Tue 20 Oct · linked by you');
    expect(row?.instagram).toEqual({
      kind: 'reel',
      url: 'https://www.instagram.com/reel/KnownByJob/',
    });
  });

  it('has no Open reel link when nobody knows where the reel is', () => {
    expect(instagramRow(uploaded, linked(null), UTC)?.instagram).toEqual({
      kind: 'reel',
      url: null,
    });
  });

  it('still has the row for a paid job the reel is linked to', () => {
    expect(instagramRow(jobSheetJobs.paid, linked(), UTC)).toBeNull();
    const paid: Job = {
      ...jobSheetJobs.paid,
      delivery: makeJobDelivery({ paidOn: '2026-10-22', uploadedAt: '2026-10-20T09:30:00.000Z' }),
    };
    expect(instagramRow(paid, linked(), UTC)?.label).toBe(ON_INSTAGRAM_LABEL);
  });

  it('has no row when the job says no reel is linked (the delivery has no uploadedAt)', () => {
    expect(instagramRow(delivered, linked(), UTC)).toBeNull();
  });
});

describe('instagramRow: a delivered job no reel is linked to', () => {
  it('says where to link one, muted, with the client’s page as the link', () => {
    expect(instagramRow(delivered, NONE, UTC)).toEqual({
      label: 'On Instagram',
      value: `No reel linked yet. Link it from ${delivered.client}’s page.`,
      muted: true,
      instagram: { kind: 'none', clientId: delivered.clientId, client: delivered.client },
    });
  });

  it('has no second line', () => {
    expect(instagramRow(delivered, NONE, UTC)?.sub).toBeUndefined();
  });

  it('has nothing to say when the job has a reel after all', () => {
    expect(instagramRow(uploaded, NONE, UTC)).toBeNull();
  });
});

describe('instagramRow: nothing to show', () => {
  it('is nothing while the switch is off (no instagram given)', () => {
    expect(instagramRow(uploaded, null, UTC)).toBeNull();
    expect(instagramRow(uploaded, undefined, UTC)).toBeNull();
    expect(instagramRow(delivered, null, UTC)).toBeNull();
  });

  it('is nothing for a job that is not finished', () => {
    for (const state of ['review', 'editing', 'queued', 'approved', 'failed'] as const) {
      expect(instagramRow(jobSheetJobs[state], NONE, UTC), state).toBeNull();
      expect(instagramRow(jobSheetJobs[state], linked(), UTC), state).toBeNull();
    }
  });

  it('is nothing for a job that left ready though it keeps its delivery', () => {
    const retried: Job = { ...uploaded, state: 'editing' };
    expect(instagramRow(retried, linked(), UTC)).toBeNull();
  });
});

describe('detailRows with the On Instagram row', () => {
  const labels = (job: Job, instagram?: SheetInstagram | null) =>
    detailRows(job, now, UTC, undefined, instagram).map((row) => row.label);

  it('puts it where Posted was, right after Money', () => {
    expect(labels(uploaded, linked()).slice(0, 2)).toEqual(['Money', 'On Instagram']);
  });

  it('replaces Posted, not adds to it', () => {
    expect(labels(uploaded, linked())).not.toContain('Posted');
  });

  it('keeps Posted while the switch is off', () => {
    expect(labels(uploaded, null)).toContain('Posted');
    expect(labels(uploaded, null)).not.toContain('On Instagram');
    expect(labels(uploaded)).toContain('Posted');
  });

  it('keeps Posted when the reel’s numbers are not in yet: the row says a dash, not nothing', () => {
    const rows = detailRows(uploaded, now, UTC, undefined, linked(null));
    expect(rows.find((row) => row.label === 'On Instagram')?.value).toBe('—');
  });

  it('adds "No reel linked yet" to a delivered job with no reel', () => {
    const rows = detailRows(delivered, now, UTC, undefined, NONE);
    expect(rows.find((row) => row.label === 'On Instagram')?.value).toContain(
      'No reel linked yet.',
    );
  });

  it('leaves a job that is not delivered as it was', () => {
    expect(labels(jobSheetJobs.review, NONE)).toEqual(labels(jobSheetJobs.review));
  });
});

describe('phoneDetailRows with the On Instagram row', () => {
  const rows = (job: Job, instagram?: SheetInstagram | null) =>
    phoneDetailRows(job, now, UTC, null, undefined, instagram) ?? [];
  const labels = (job: Job, instagram?: SheetInstagram | null) =>
    rows(job, instagram).map((row) => row.label);

  it('has it after Delivered, in Posted’s place', () => {
    const list = labels(uploaded, linked());
    expect(list.indexOf('On Instagram')).toBe(list.indexOf('Delivered') + 1);
    expect(list).not.toContain('Posted');
  });

  it('says where to link a reel for a delivered job with none', () => {
    const row = rows(delivered, NONE).find((r) => r.label === 'On Instagram');
    expect(row?.value).toBe(`No reel linked yet. Link it from ${delivered.client}’s page.`);
    expect(row?.instagram).toEqual({
      kind: 'none',
      clientId: delivered.clientId,
      client: delivered.client,
    });
  });

  it('is as it was while the switch is off', () => {
    expect(labels(uploaded, null)).toContain('Posted');
    expect(labels(uploaded, null)).not.toContain('On Instagram');
    expect(labels(delivered, null)).not.toContain('On Instagram');
  });

  it('also has it for an editor’s job (no money)', () => {
    const editors: Job = {
      ...uploaded,
      delivery: { deliveredAt: '2026-10-21T14:00:00.000Z', uploadedAt: '2026-10-20T09:30:00.000Z' },
    };
    const list = rows(editors, linked());
    expect(list.map((row) => row.label)).toEqual(['Delivered', 'On Instagram', 'File']);
  });
});
