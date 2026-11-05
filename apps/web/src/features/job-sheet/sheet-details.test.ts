import { describe, expect, it } from 'vitest';
import { makeJobDelivery } from '@/data/test-utils';
import {
  addedText,
  type DetailLabel,
  detailRows,
  historyTime,
  inputParts,
  inputsText,
  phoneDetailRows,
} from './sheet-details';
import { JOB_SHEET_STATES, type JobSheetState, jobSheetJobs, jobSheetNow } from './test-fixtures';

// The fixtures keep UTC clock times, so every test pins UTC.
const UTC = 'UTC';

const rowsOf = (state: JobSheetState) => detailRows(jobSheetJobs[state], jobSheetNow[state], UTC);

/** The rows as `label: value`, to compare a whole part at once. */
const lines = (state: JobSheetState) => rowsOf(state).map((row) => `${row.label}: ${row.value}`);

describe('inputsText', () => {
  it('names the kinds of file with their counts, in order, and leaves out the ones with none', () => {
    expect(inputsText({ video: 8, audio: 1, image: 3, doc: 0 })).toBe(
      '8 video clips · 1 audio file · 3 images',
    );
    expect(inputsText({ video: 5, audio: 0, image: 0, doc: 1 })).toBe('5 video clips · 1 document');
    expect(inputsText({ video: 1, audio: 0, image: 1, doc: 0 })).toBe('1 video clip · 1 image');
  });

  it('joins with the separator it is given', () => {
    expect(inputsText({ video: 3, audio: 0, image: 2, doc: 0 }, ', ')).toBe(
      '3 video clips, 2 images',
    );
  });

  it('is empty for a folder with no files', () => {
    expect(inputsText({ video: 0, audio: 0, image: 0, doc: 0 })).toBe('');
    expect(inputParts({ video: 0, audio: 0, image: 0, doc: 0 })).toEqual([]);
  });
});

describe('addedText and historyTime', () => {
  const now = '2026-10-22T15:00:00.000Z';

  it('says Today, Yesterday or the day, then the time', () => {
    expect(addedText('2026-10-22T13:01:00.000Z', now, UTC)).toBe('Today, 13:01');
    expect(addedText('2026-10-21T16:19:00.000Z', now, UTC)).toBe('Yesterday, 16:19');
    expect(addedText('2026-10-20T10:01:00.000Z', now, UTC)).toBe('20 Oct, 10:01');
    expect(addedText('2026-09-05T09:05:00.000Z', now, UTC)).toBe('5 Sep, 09:05');
  });

  it('shows the time for today and the day for any earlier day', () => {
    expect(historyTime('2026-10-22T00:00:00.000Z', now, UTC)).toBe('00:00');
    expect(historyTime('2026-10-22T14:59:00.000Z', now, UTC)).toBe('14:59');
    expect(historyTime('2026-10-21T23:59:00.000Z', now, UTC)).toBe('21 Oct');
    expect(historyTime('2026-01-02T08:00:00.000Z', now, UTC)).toBe('2 Jan');
  });

  it('counts the days on the calendar, not in 24 hours', () => {
    // 23:50 the evening before is yesterday even though it is 20 minutes ago.
    expect(addedText('2026-10-21T23:50:00.000Z', '2026-10-22T00:10:00.000Z', UTC)).toBe(
      'Yesterday, 23:50',
    );
    expect(historyTime('2026-10-21T23:50:00.000Z', '2026-10-22T00:10:00.000Z', UTC)).toBe('21 Oct');
  });

  it('reads the wall clock of the zone it is given', () => {
    // 22:30 UTC on the 21st is 01:30 on the 22nd in Jerusalem (UTC+3 until 25 Oct).
    const late = '2026-10-21T22:30:00.000Z';
    expect(addedText(late, now, UTC)).toBe('Yesterday, 22:30');
    expect(addedText(late, now, 'Asia/Jerusalem')).toBe('Today, 01:30');
    expect(historyTime(late, now, 'Asia/Jerusalem')).toBe('01:30');
  });

  it('reads the browser zone without one, and a time after now as today', () => {
    expect(addedText('2026-10-22T16:00:00.000Z', now, UTC)).toBe('Today, 16:00');
    const local = new Date(2026, 9, 22, 8, 5);
    expect(addedText(local, new Date(2026, 9, 22, 12, 0))).toBe('Today, 08:05');
    expect(historyTime(local, new Date(2026, 9, 23, 12, 0))).toBe('22 Oct');
  });

  it('gives nothing for a time that cannot be read', () => {
    expect(addedText('nope', now, UTC)).toBe('');
    expect(historyTime('nope', now, UTC)).toBe('');
    expect(historyTime(now, 'nope', UTC)).toBe('');
  });
});

describe('detailRows, per state of the boards', () => {
  const labels = (state: JobSheetState): DetailLabel[] => rowsOf(state).map((row) => row.label);

  it('has the rows of the boards, in order', () => {
    expect(labels('arriving')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('queued')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('held')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('editing')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('review')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('reviewRound2')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('rendering')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('failed')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('cancelled')).toEqual(['Inputs', 'Added', 'Folder']);
    expect(labels('approved')).toEqual(['Video', 'File', 'Inputs', 'Added']);
    expect(labels('delivered')).toEqual(['Money', 'Video', 'File', 'Inputs', 'Added']);
    expect(labels('paid')).toEqual(['Money', 'Video', 'File', 'Inputs', 'Added']);
    expect(labels('archived')).toEqual(['Money', 'Video', 'File', 'Inputs', 'Added']);
  });

  it('reads like the arriving board: the files that are in so far', () => {
    expect(lines('arriving')).toEqual([
      'Inputs: 3 video clips so far',
      'Added: Today, 15:02',
      'Folder: Studio Inbox/LAKESHORE/צילומי לקוחות – אוקטובר',
    ]);
  });

  it('reads like the failed board', () => {
    expect(lines('failed')).toEqual([
      'Inputs: 4 video clips · 1 audio file',
      'Added: Today, 12:09',
      'Folder: Studio Inbox/RGM/ראיון עם המייסד',
    ]);
  });

  it('reads like the approved board: the video and its file, and no folder', () => {
    expect(lines('approved')).toEqual([
      'Video: 0:30 · 1080×1920 · 27 MB',
      'File: _Exports/RGM/טורניר בחירות שש בש.mp4',
      'Inputs: 6 video clips · 1 audio file · 2 images',
      'Added: Today, 11:39',
    ]);
  });

  it('reads like the delivered board: owed money, with the day it was delivered', () => {
    expect(lines('delivered')).toEqual([
      'Money: ₪40 · delivered 21 Oct · not paid',
      'Video: 0:52 · 1080×1920 · 31 MB',
      'File: _Exports/LAKESHORE/אדריכלות.mp4',
      'Inputs: 9 video clips · 1 audio file',
      // The boards say "21 Oct, 10:01", but the day before the board's own "today" is Yesterday.
      'Added: Yesterday, 10:01',
    ]);
  });

  it('reads like the paid board: the day the money came in', () => {
    expect(lines('paid')).toEqual([
      'Money: ₪40 · delivered 21 Oct · paid 21 Oct',
      'Video: 0:36 · 1080×1920 · 26 MB',
      'File: _Exports/עו״ד דוד לוי/מיתוס או אמת 5.mp4',
      'Inputs: 5 video clips · 1 audio file',
      'Added: 20 Oct, 16:19',
    ]);
  });

  it('reads like the archived board', () => {
    expect(lines('archived')).toEqual([
      'Money: ₪40 · delivered 12 Sep · paid 28 Sep',
      'Video: 0:45 · 1080×1920 · 34 MB',
      'File: _Exports/RGM/קמפיין קיץ.mp4',
      'Inputs: 7 video clips · 1 audio file',
      'Added: 10 Sep, 09:12',
    ]);
  });

  it('shows the paths muted and the other values in the normal colour', () => {
    for (const state of JOB_SHEET_STATES) {
      for (const row of rowsOf(state)) {
        expect(row.muted, `${state} ${row.label}`).toBe(
          row.label === 'File' || row.label === 'Folder',
        );
      }
    }
  });

  it('only has the Folder row until there is an MP4', () => {
    for (const state of JOB_SHEET_STATES) {
      const job = jobSheetJobs[state];
      expect(
        rowsOf(state).some((row) => row.label === 'Folder'),
        state,
      ).toBe(job.output === null);
    }
  });

  it('puts the folder of a job in Studio Inbox, as the job folder is named', () => {
    const [folder] = rowsOf('queued').filter((row) => row.label === 'Folder');
    expect(folder?.value).toBe('Studio Inbox/RGM/טורניר בחירות – הכרזה');
  });
});

describe('detailRows, the details of a row', () => {
  const now = jobSheetNow.delivered;

  it('has no Money row for a job that is not delivered', () => {
    expect(detailRows(jobSheetJobs.approved, now, UTC).map((row) => row.label)).not.toContain(
      'Money',
    );
  });

  it('has no Money row once a delivered job left ready (it keeps its delivery for a retry)', () => {
    const retried = { ...jobSheetJobs.delivered, state: 'editing' as const };
    expect(detailRows(retried, now, UTC).map((row) => row.label)).not.toContain('Money');
  });

  it('writes a price that is not whole, and a currency without a sign of its own', () => {
    const job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({ price: 37.5, currency: 'EUR' }),
    };
    expect(detailRows(job, now, UTC)[0]?.value).toBe('EUR 37.50 · delivered 21 Oct · not paid');
  });

  it('gives the day the money came in as it was written, not as a moment', () => {
    const job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({ deliveredAt: '2026-10-21T23:30:00.000Z', paidOn: '2026-10-22' }),
    };
    expect(detailRows(job, now, UTC)[0]?.value).toBe('₪40 · delivered 21 Oct · paid 22 Oct');
  });

  it('has a Posted row, right after Money, once a reel is linked to the delivered job', () => {
    const job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({ uploadedAt: '2026-10-20T09:30:00.000Z' }),
    };
    const rows = detailRows(job, now, UTC);
    expect(rows.slice(0, 2).map((row) => `${row.label}: ${row.value}`)).toEqual([
      'Money: ₪40 · delivered 21 Oct · not paid',
      'Posted: Tue 20 Oct',
    ]);
  });

  it('has no Posted row while no reel is linked, and none once the job left ready', () => {
    expect(detailRows(jobSheetJobs.delivered, now, UTC).map((row) => row.label)).not.toContain(
      'Posted',
    );
    const retried = {
      ...jobSheetJobs.delivered,
      state: 'editing' as const,
      delivery: makeJobDelivery({ uploadedAt: '2026-10-20T09:30:00.000Z' }),
    };
    expect(detailRows(retried, now, UTC).map((row) => row.label)).not.toContain('Posted');
  });

  it('an editor’s job (no money) still has its Posted row', () => {
    const job = {
      ...jobSheetJobs.delivered,
      delivery: { deliveredAt: '2026-10-21T14:00:00.000Z', uploadedAt: '2026-10-20T09:30:00.000Z' },
    };
    const rows = detailRows(job, now, UTC).map((row) => `${row.label}: ${row.value}`);
    expect(rows).toContain('Posted: Tue 20 Oct');
    expect(rows.some((line) => line.startsWith('Money'))).toBe(false);
  });

  it('leaves out Inputs when the folder has no files', () => {
    const job = { ...jobSheetJobs.held, inputs: { video: 0, audio: 0, image: 0, doc: 0 } };
    expect(detailRows(job, jobSheetNow.held, UTC).map((row) => row.label)).toEqual([
      'Added',
      'Folder',
    ]);
  });

  it('does not say "so far" once the files stopped arriving', () => {
    const queued = detailRows(jobSheetJobs.queued, jobSheetNow.queued, UTC);
    expect(queued[0]?.value).not.toContain('so far');
  });

  it('reads Added on the calendar of the zone it is given', () => {
    const job = { ...jobSheetJobs.review, addedAt: '2026-10-21T22:30:00.000Z' };
    const added = (timeZone: string) =>
      detailRows(job, jobSheetNow.review, timeZone).find((row) => row.label === 'Added')?.value;
    expect(added('UTC')).toBe('Yesterday, 22:30');
    expect(added('Asia/Jerusalem')).toBe('Today, 01:30');
  });

  it('leaves out Added when the time cannot be read', () => {
    const job = { ...jobSheetJobs.review, addedAt: 'nope' };
    expect(detailRows(job, jobSheetNow.review, UTC).map((row) => row.label)).toEqual([
      'Inputs',
      'Folder',
    ]);
  });
});

describe('phoneDetailRows: the phone’s Details of a finished job (CVP-277)', () => {
  const SUMMARY = 'All 8 steps done · 26 min of work';
  const phoneLines = (state: JobSheetState, summary: string | null = SUMMARY) =>
    phoneDetailRows(jobSheetJobs[state], jobSheetNow[state], UTC, summary)?.map(
      (row) => `${row.label}: ${row.value}`,
    ) ?? null;

  it('reads like board MJobSheet for an approved job: Steps, Inputs, Approved, File', () => {
    expect(phoneLines('approved')).toEqual([
      `Steps: ${SUMMARY}`,
      'Inputs: 6 video clips · 1 audio file · 2 images',
      'Approved: Today, 13:55',
      'File: טורניר בחירות שש בש.mp4',
    ]);
  });

  it('leaves Steps out until the steps are loaded', () => {
    expect(phoneLines('approved', null)?.map((line) => line.split(':')[0])).toEqual([
      'Inputs',
      'Approved',
      'File',
    ]);
  });

  it('reads like board MJobSheetDelivered: Delivered, Price, Paid “Not yet”, File', () => {
    expect(phoneLines('delivered')).toEqual([
      'Delivered: Yesterday, 14:00',
      'Price: ₪40',
      'Paid: Not yet',
      'File: אדריכלות.mp4',
    ]);
  });

  it('adds Posted after Delivered while a reel is linked: Delivered, Posted, Price, Paid, File', () => {
    const job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({
        deliveredAt: '2026-10-21T14:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
      }),
    };
    const rows = phoneDetailRows(job, jobSheetNow.delivered, UTC, SUMMARY) ?? [];
    expect(rows.map((row) => `${row.label}: ${row.value}`)).toEqual([
      'Delivered: Yesterday, 14:00',
      'Posted: Tue 20 Oct',
      'Price: ₪40',
      'Paid: Not yet',
      'File: אדריכלות.mp4',
    ]);
  });

  it('adds Posted to a paid job’s rows too, after Delivered', () => {
    const job = jobSheetJobs.paid;
    const linked = {
      ...job,
      delivery: job.delivery && { ...job.delivery, uploadedAt: '2026-10-20T09:30:00.000Z' },
    };
    const rows = phoneDetailRows(linked, jobSheetNow.paid, UTC, SUMMARY) ?? [];
    expect(rows.map((row) => row.label)).toEqual(['Delivered', 'Posted', 'Paid', 'Price', 'File']);
  });

  it('reads like board MJobSheetPaid: Delivered, Paid, Price, File', () => {
    expect(phoneLines('paid')).toEqual([
      'Delivered: Yesterday, 09:00',
      'Paid: 21 Oct',
      'Price: ₪40',
      'File: מיתוס או אמת 5.mp4',
    ]);
    expect(phoneLines('archived')?.[1]).toBe('Paid: 28 Sep');
  });

  it('adds what was paid under the price when the client paid something else (₪0 included)', () => {
    const job = jobSheetJobs.paid;
    const free = { ...job, delivery: job.delivery && { ...job.delivery, paidAmount: 0 } };
    const rows = phoneDetailRows(free, jobSheetNow.paid, UTC, SUMMARY) ?? [];
    expect(rows.map((row) => `${row.label}: ${row.value}`)).toEqual([
      'Delivered: Yesterday, 09:00',
      'Paid: 21 Oct',
      'Price: ₪40',
      'Amount paid: ₪0',
      'File: מיתוס או אמת 5.mp4',
    ]);
  });

  it('shows every value in the normal colour, the file name too', () => {
    const rows = phoneDetailRows(jobSheetJobs.paid, jobSheetNow.paid, UTC, SUMMARY) ?? [];
    expect(rows.every((row) => !row.muted)).toBe(true);
  });

  it('is null for a job that is not finished, which keeps the Mac’s rows', () => {
    for (const state of ['held', 'arriving', 'failed'] as const) {
      expect(phoneLines(state)).toBeNull();
    }
  });
});
