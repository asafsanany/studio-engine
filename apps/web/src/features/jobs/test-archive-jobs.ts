// Test data for Show archived (CVP-197): the Jobs board of the design canvas's Archive page, ten
// jobs on the list and five archived, for three clients. Not imported by the app.

import type { Job } from '@studio/shared';
import { makeJob, makeJobDelivery } from '@/data/test-utils';

export const ARCHIVE_CLIENT_IDS = {
  'עו״ד דוד לוי': 'a1a1a1a1a1a1',
  RGM: 'b2b2b2b2b2b2',
  LAKESHORE: 'c3c3c3c3c3c3',
} as const;

type ArchiveClient = keyof typeof ARCHIVE_CLIENT_IDS;

/** The moment the board shows archived jobs at: 21 Oct, whatever the zone (noon UTC). */
export const ARCHIVED_AT = '2026-10-21T12:00:00.000Z';

function job(
  id: string,
  name: string,
  client: ArchiveClient,
  updatedAt: string,
  overrides: Partial<Job> = {},
): Job {
  return makeJob({
    id,
    name,
    client,
    clientId: ARCHIVE_CLIENT_IDS[client],
    relPath: `${client}/${name}`,
    placeInLine: null,
    settledAt: null,
    updatedAt,
    ...overrides,
  });
}

const delivered = (day: string) => makeJobDelivery({ deliveredAt: `${day}T09:00:00.000Z` });
const paid = (day: string, paidOn: string) =>
  makeJobDelivery({ deliveredAt: `${day}T09:00:00.000Z`, paidOn });

/**
 * The board: an editing, a review and a failed job, an approved one, a delivered one and two paid
 * ones on the list; and, archived, a cancelled job, three paid ones and a delivered one. Newest
 * update first, as the list shows them.
 */
export const ARCHIVE_JOBS: readonly Job[] = [
  job('editing-1', 'מיתוס או אמת 6', 'עו״ד דוד לוי', '2026-10-21T11:59:00.000Z', {
    state: 'editing',
    step: 5,
    subProgress: 'graphics 2/5',
  }),
  job('review-1', 'סיור בפרויקט', 'LAKESHORE', '2026-10-21T11:51:00.000Z', {
    state: 'review',
    step: 7,
    preview: { durationSec: 44, width: 1080, height: 1920 },
  }),
  job('failed-1', 'בדיקת סאונד', 'LAKESHORE', '2026-10-21T10:00:00.000Z', {
    state: 'failed',
    failedAt: 5,
    error: 'clip 3 will not open',
  }),
  job('approved-1', 'טורניר בחירות שש בש', 'RGM', '2026-10-21T09:00:00.000Z', {
    state: 'ready',
    approvedAt: '2026-10-21T08:30:00.000Z',
  }),
  job('delivered-1', 'הכרזת הטורניר', 'RGM', '2026-10-19T09:00:00.000Z', {
    state: 'ready',
    delivery: delivered('2026-10-19'),
  }),
  job('paid-1', 'ראיון עם המייסד', 'RGM', '2026-10-14T09:00:00.000Z', {
    state: 'ready',
    delivery: paid('2026-10-09', '2026-10-14'),
  }),
  job('paid-2', 'מיתוס או אמת 2', 'עו״ד דוד לוי', '2026-10-12T09:00:00.000Z', {
    state: 'ready',
    delivery: paid('2026-10-05', '2026-10-12'),
  }),
  job('archived-cancelled', 'טיוטה ישנה', 'RGM', '2026-10-06T09:00:00.000Z', {
    state: 'cancelled',
    stoppedAt: 5,
    archivedAt: ARCHIVED_AT,
  }),
  job('archived-paid-1', 'שאלות נפוצות 1', 'עו״ד דוד לוי', '2026-10-06T08:00:00.000Z', {
    state: 'ready',
    delivery: paid('2026-09-30', '2026-10-06'),
    archivedAt: ARCHIVED_AT,
  }),
  job('archived-paid-2', 'פתיחת הסניף', 'RGM', '2026-09-30T08:00:00.000Z', {
    state: 'ready',
    delivery: paid('2026-09-24', '2026-09-30'),
    archivedAt: ARCHIVED_AT,
  }),
  job('archived-paid-3', 'סרטון תדמית', 'LAKESHORE', '2026-09-26T08:00:00.000Z', {
    state: 'ready',
    delivery: paid('2026-09-20', '2026-09-26'),
    archivedAt: ARCHIVED_AT,
  }),
  job('archived-delivered', 'מיתוס או אמת 1', 'עו״ד דוד לוי', '2026-09-28T08:00:00.000Z', {
    state: 'ready',
    delivery: delivered('2026-09-28'),
    archivedAt: ARCHIVED_AT,
  }),
];

/** The ids of the jobs that are archived on the board. */
export const ARCHIVED_IDS = ARCHIVE_JOBS.filter((j) => j.archivedAt !== null).map((j) => j.id);

/** The ids of the jobs that are on the list (not archived). */
export const LIVE_IDS = ARCHIVE_JOBS.filter((j) => j.archivedAt === null).map((j) => j.id);
