// Test data for the Jobs list: the twelve jobs of the design canvas's Jobs board, with the same
// states, names, clients, input counts and ages, taken at `NOW`. Not imported by the app.

import type { Job } from '@studio/shared';
import { makeJob } from '@/data/test-utils';
import { createJobsUiStore } from '@/stores/jobs-ui';

/**
 * A Jobs UI store for server-rendered tests. zustand's `useStore` reads the store's *initial*
 * state when rendering on a server, so a test that changes the state and then renders would see
 * the defaults. This points that snapshot at the current state instead.
 */
export function createTestStore() {
  const store = createJobsUiStore();
  store.getInitialState = () => store.getState();
  return store;
}

/** The moment the canvas shows ("Tue 20 Oct 2026, 13:42"), in UTC. */
export const NOW = '2026-10-20T13:42:00.000Z';

const GB = 1_000_000_000;
const MB = 1_000_000;

/** The ids the server gives these client folders (the first 12 hex characters of sha1, NFC). */
export const CLIENT_IDS = {
  'מאפיית הצפון': '4d337086919d',
  'Arc Fitness': '27ad66831f94',
  'מרפאת מירה': 'ac02adfdda21',
  'Kova Coffee': 'eba5851d92fa',
  'טל נכסים': '7e7c247dca0d',
  'Noa Ceramics': 'cd7b364b61bf',
  'Lumen Yoga': 'e9e52fd8a1f1',
} as const;

function job(
  id: string,
  overrides: Partial<Job> & Pick<Job, 'name' | 'client' | 'state' | 'addedAt' | 'updatedAt'>,
): Job {
  return makeJob({
    id,
    clientId: CLIENT_IDS[overrides.client as keyof typeof CLIENT_IDS],
    relPath: `${overrides.client}/${overrides.name}`,
    placeInLine: null,
    settledAt: null,
    ...overrides,
  });
}

const inputs = (video: number, audio: number, image: number, doc: number) => ({
  video,
  audio,
  image,
  doc,
});

/** In the order the canvas lists them (j1 to j12), not in display order. */
export const CANVAS_JOBS: readonly Job[] = [
  job('j1', {
    state: 'arriving',
    name: 'פרומו לסוף השבוע',
    client: 'מאפיית הצפון',
    inputs: inputs(14, 3, 1, 1),
    sizeBytes: 3.1 * GB,
    addedAt: '2026-10-20T13:41:00.000Z',
    updatedAt: '2026-10-20T13:41:00.000Z',
    settlesAt: '2026-10-20T13:42:42.000Z',
  }),
  job('j2', {
    state: 'queued',
    name: 'Class schedule',
    client: 'Arc Fitness',
    inputs: inputs(0, 1, 5, 0),
    sizeBytes: 48 * MB,
    addedAt: '2026-10-20T13:30:00.000Z',
    updatedAt: '2026-10-20T13:31:00.000Z',
    placeInLine: 2,
    settledAt: '2026-10-20T13:31:00.000Z',
  }),
  job('j3', {
    state: 'held',
    name: 'סרטון גיוס – Hiring video',
    client: 'מאפיית הצפון',
    inputs: inputs(6, 2, 1, 0),
    sizeBytes: 1.1 * GB,
    addedAt: '2026-10-20T13:17:00.000Z',
    updatedAt: '2026-10-20T13:22:00.000Z',
  }),
  job('j4', {
    state: 'queued',
    name: 'Patient testimonial',
    client: 'מרפאת מירה',
    inputs: inputs(2, 1, 4, 0),
    sizeBytes: 1.4 * GB,
    addedAt: '2026-10-20T13:11:00.000Z',
    updatedAt: '2026-10-20T13:12:00.000Z',
    placeInLine: 1,
    settledAt: '2026-10-20T13:12:00.000Z',
  }),
  job('j5', {
    state: 'editing',
    name: 'Coach intro reel',
    client: 'Arc Fitness',
    inputs: inputs(9, 0, 1, 1),
    sizeBytes: 2.2 * GB,
    addedAt: '2026-10-20T12:54:00.000Z',
    updatedAt: '2026-10-20T13:42:00.000Z',
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
  }),
  job('j6', {
    state: 'ready',
    name: 'השקת תפריט חדש',
    client: 'Kova Coffee',
    inputs: inputs(11, 0, 7, 0),
    sizeBytes: 2.8 * GB,
    addedAt: '2026-10-20T11:42:00.000Z',
    updatedAt: '2026-10-20T11:58:00.000Z',
    step: 8,
    output: {
      fileName: 'Kova Coffee/השקת תפריט חדש.mp4',
      durationSec: 45,
      width: 1080,
      height: 1920,
      sizeBytes: 62 * MB,
    },
  }),
  job('j7', {
    state: 'failed',
    name: 'Open house tour',
    client: 'טל נכסים',
    inputs: inputs(22, 0, 0, 1),
    sizeBytes: 7.9 * GB,
    addedAt: '2026-10-20T10:42:00.000Z',
    updatedAt: '2026-10-20T12:07:00.000Z',
    step: 8,
    failedAt: 8,
    error: 'Render stopped: not enough disk space.',
  }),
  job('j8', {
    state: 'cancelled',
    name: 'Summer menu teaser',
    client: 'Kova Coffee',
    inputs: inputs(5, 1, 2, 0),
    sizeBytes: 900 * MB,
    addedAt: '2026-10-20T08:42:00.000Z',
    updatedAt: '2026-10-20T09:02:00.000Z',
    step: 4,
    stoppedAt: 4,
  }),
  job('j9', {
    state: 'ready',
    name: 'טיפים להלבנת שיניים',
    client: 'מרפאת מירה',
    inputs: inputs(4, 2, 0, 0),
    sizeBytes: 1.6 * GB,
    addedAt: '2026-10-19T13:20:00.000Z',
    updatedAt: '2026-10-19T13:22:00.000Z',
    step: 8,
  }),
  job('j10', {
    state: 'ready',
    name: 'Studio tour',
    client: 'Arc Fitness',
    inputs: inputs(8, 0, 1, 0),
    sizeBytes: 2.0 * GB,
    addedAt: '2026-10-19T12:22:00.000Z',
    updatedAt: '2026-10-19T12:32:00.000Z',
    step: 8,
  }),
  job('j11', {
    state: 'ready',
    name: 'Apartment 4B walkthrough',
    client: 'טל נכסים',
    inputs: inputs(12, 0, 0, 1),
    sizeBytes: 3.3 * GB,
    addedAt: '2026-10-18T15:10:00.000Z',
    updatedAt: '2026-10-18T15:32:00.000Z',
    step: 8,
  }),
  job('j12', {
    state: 'ready',
    name: 'מאפים של בוקר',
    client: 'מאפיית הצפון',
    inputs: inputs(6, 1, 0, 0),
    sizeBytes: 640 * MB,
    addedAt: '2026-10-17T10:15:00.000Z',
    updatedAt: '2026-10-17T10:32:00.000Z',
    step: 8,
  }),
];

/** The ids in the order the Jobs board shows them by default: Last updated, newest first. */
export const DEFAULT_ORDER = [
  'j5',
  'j1',
  'j2',
  'j3',
  'j4',
  'j7',
  'j6',
  'j8',
  'j9',
  'j10',
  'j11',
  'j12',
] as const;

const PORTRAIT_PREVIEW = { durationSec: 28.4, width: 1080, height: 1920 };

/** The Phase 3 rows board (P3Rows), at NOW: a job in Review, a revise run and the render run. */
export const REVIEW_ROW_JOBS: readonly Job[] = [
  job('r1', {
    state: 'review',
    name: 'פרומו לסוף השבוע',
    client: 'מאפיית הצפון',
    inputs: inputs(14, 3, 1, 1),
    sizeBytes: 3.1 * GB,
    addedAt: '2026-10-20T12:10:00.000Z',
    updatedAt: '2026-10-20T13:40:00.000Z',
    step: 7,
    preview: PORTRAIT_PREVIEW,
  }),
  job('r2', {
    state: 'editing',
    name: 'Spring promo',
    client: 'Kova Coffee',
    inputs: inputs(8, 1, 3, 0),
    sizeBytes: 1.9 * GB,
    addedAt: '2026-10-20T11:30:00.000Z',
    updatedAt: '2026-10-20T13:41:00.000Z',
    runKind: 'revise',
    // One round of notes was sent, so this is the second cut: the row says "round 2".
    round: 1,
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
    preview: PORTRAIT_PREVIEW,
  }),
  job('r3', {
    state: 'editing',
    name: 'Hiring reel',
    client: 'Lumen Dental',
    inputs: inputs(10, 0, 2, 1),
    sizeBytes: 2.4 * GB,
    addedAt: '2026-10-20T10:05:00.000Z',
    updatedAt: '2026-10-20T13:42:00.000Z',
    runKind: 'render',
    round: 1,
    step: 8,
    etaSec: 180,
    approvedAt: '2026-10-20T13:41:30.000Z',
    preview: PORTRAIT_PREVIEW,
  }),
];

/** The ids of the clients on the Phase 4 board (they are not in `CLIENT_IDS`, which the Clients tests count). */
export const DELIVERY_CLIENT_IDS = {
  RGM: '5a1f0c2b9d43',
  LAKESHORE: '8e3b6d71a0c5',
  'עו״ד דוד לוי': 'b7c94e2f1a68',
} as const;

/** A delivery for these tests: ₪40, delivered at 09:00 UTC on `day`, paid on `paidOn` (or not). */
function delivery(day: string, paidOn: string | null = null): NonNullable<Job['delivery']> {
  return { deliveredAt: `${day}T09:00:00.000Z`, price: 40, currency: 'ILS', paidOn };
}

function deliveryJob(
  id: string,
  client: keyof typeof DELIVERY_CLIENT_IDS,
  overrides: Partial<Job> & Pick<Job, 'name' | 'state'>,
): Job {
  return job(id, {
    client,
    clientId: DELIVERY_CLIENT_IDS[client],
    addedAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:30:00.000Z',
    ...overrides,
  });
}

const exported = (name: string, durationSec: number, megabytes: number): Job['output'] => ({
  fileName: `${name}.mp4`,
  durationSec,
  width: 1080,
  height: 1920,
  sizeBytes: megabytes * MB,
});

/**
 * The Phase 4 board (DPJobs): one job editing, one in Review, three Approved, three Delivered and
 * two Paid. The tabs count 10, 1, 1, 3, 3, 2 and 0.
 */
export const DELIVERY_ROW_JOBS: readonly Job[] = [
  deliveryJob('d1', 'עו״ד דוד לוי', {
    state: 'editing',
    name: 'מיתוס או אמת 6',
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
  }),
  deliveryJob('d2', 'LAKESHORE', {
    state: 'review',
    name: 'סיור בפרויקט',
    step: 7,
    preview: PORTRAIT_PREVIEW,
  }),
  deliveryJob('d3', 'RGM', {
    state: 'ready',
    name: 'טורניר בחירות שש בש',
    output: exported('טורניר בחירות שש בש', 30, 27),
  }),
  deliveryJob('d4', 'LAKESHORE', {
    state: 'ready',
    name: 'אדריכלות',
    output: exported('אדריכלות', 52, 31),
  }),
  deliveryJob('d5', 'עו״ד דוד לוי', {
    state: 'ready',
    name: 'מיתוס או אמת 5',
    output: exported('מיתוס או אמת 5', 36, 26),
  }),
  deliveryJob('d6', 'RGM', {
    state: 'ready',
    name: 'הכרזת הטורניר',
    output: exported('הכרזת הטורניר', 28, 24),
    delivery: delivery('2026-10-19'),
  }),
  deliveryJob('d7', 'עו״ד דוד לוי', {
    state: 'ready',
    name: 'מיתוס או אמת 4',
    output: exported('מיתוס או אמת 4', 41, 29),
    delivery: delivery('2026-10-16'),
  }),
  deliveryJob('d8', 'עו״ד דוד לוי', {
    state: 'ready',
    name: 'מיתוס או אמת 3',
    output: exported('מיתוס או אמת 3', 39, 28),
    delivery: delivery('2026-10-12'),
  }),
  deliveryJob('d9', 'RGM', {
    state: 'ready',
    name: 'ראיון עם המייסד',
    output: exported('ראיון עם המייסד', 58, 41),
    delivery: delivery('2026-10-09', '2026-10-14'),
  }),
  deliveryJob('d10', 'עו״ד דוד לוי', {
    state: 'ready',
    name: 'מיתוס או אמת 2',
    output: exported('מיתוס או אמת 2', 35, 25),
    delivery: delivery('2026-10-05', '2026-10-12'),
  }),
];
