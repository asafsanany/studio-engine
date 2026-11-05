// Helpers shared by the data layer's tests. Not imported by the app.

import {
  type AnalyticsResponse,
  type ComputeAnalyticsInput,
  computeAnalytics,
  type FontFaceInfo,
  type FontFamilyDetail,
  type FontFamilySummary,
  type FontRequest,
  type FontStageItem,
  type GenerateState,
  type GraphicDetail,
  type GraphicMessage,
  type GraphicSummary,
  type Job,
  type JobDelivery,
  type JobVersion,
  type LutDetail,
  type LutSummary,
  type MarkPaidRequest,
  type MeResponse,
  type MoneyResponse,
  type MusicPlan,
  type MusicRecord,
  type MusicVersion,
  type MusicView,
  type OrphanDelivery,
  type ReviewNote,
  type Series,
  type SeriesResponse,
  type SeriesSummary,
  type ServerEvent,
  type Song,
  type SongFailure,
  type TeamResponse,
  type UndoPaidRequest,
} from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { HttpResponse, http, type RequestHandler } from 'msw';
import type { Api } from './api';
import type { EventSourceFactory, EventSourceLike, ReconnectTimers } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import { jobsQueryOptions } from './jobs-query';
import { ME_KEY } from './me-query';
import { createQueryClient } from './query-client';

/** Where the MSW handlers of the tests listen; `createApi({ baseUrl: BASE_URL })` calls them. */
export const BASE_URL = 'http://studio.test';

/**
 * The Analytics answer for an engine with nothing recorded, on Thursday 22 October 2026 in Israel:
 * what `computeAnalytics` gives with no data, for the month period unless `overrides.period` says
 * `week`. Override a section to put numbers in it.
 */
export function makeAnalyticsResponse(
  overrides: Partial<AnalyticsResponse> = {},
): AnalyticsResponse {
  const input: ComputeAnalyticsInput = {
    now: Date.parse('2026-10-22T09:00:00+03:00'),
    period: overrides.period ?? 'month',
    timeZone: 'Asia/Jerusalem',
    jobs: [],
    stepRuns: [],
    sentNotes: [],
    deliveries: [],
    usage: [],
    limits: [],
    noteTopics: {},
  };
  return { ...computeAnalytics(input), ...overrides };
}

/** A valid `queued` job (the same defaults as packages/shared's test fixtures). */
export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'a1b2c3d4e5f6',
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    name: 'Spring menu',
    relPath: 'Northwind Bakery/Spring menu',
    state: 'queued',
    step: null,
    subProgress: null,
    etaSec: null,
    placeInLine: 2,
    settlesAt: null,
    failedAt: null,
    error: null,
    stoppedAt: null,
    inputs: { video: 14, audio: 1, image: 0, doc: 1 },
    sizeBytes: 1_181_116_006,
    addedAt: '2026-10-20T11:02:10.000Z',
    lastChangeAt: '2026-10-20T13:40:00.000Z',
    settledAt: '2026-10-20T13:41:00.000Z',
    heldSettledAt: null,
    runKind: 'edit',
    round: 0,
    preview: null,
    approvedAt: null,
    delivery: null,
    effort: null,
    reviewEffort: null,
    reviseTier: null,
    fixing: null,
    fixedCount: 0,
    reviseMinutes: null,
    seriesId: null,
    episode: null,
    archivedAt: null,
    updatedAt: '2026-10-20T13:41:00.000Z',
    output: null,
    note: null,
    ...overrides,
  };
}

/** A job's delivery (Mark delivered): ₪40, delivered on 21 October 2026, not paid. Override any part. */
export function makeJobDelivery(
  overrides: Partial<JobDelivery> = {},
): JobDelivery & { price: number; currency: string } {
  return {
    deliveredAt: '2026-10-21T09:00:00.000Z',
    price: 40,
    currency: 'ILS',
    paidOn: null,
    ...overrides,
  };
}

/**
 * A delivered video whose folder was deleted ("History check", ₪40, delivered on 21 October 2026,
 * not paid). Override any part; `delivery` is replaced as a whole.
 */
export function makeOrphanDelivery(overrides: Partial<OrphanDelivery> = {}): OrphanDelivery {
  return {
    id: 'ba039bc47665',
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    name: 'History check',
    relPath: 'Northwind Bakery/History check',
    delivery: makeJobDelivery(),
    ...overrides,
  };
}

export interface DeliveryHandlersOptions {
  /** Where the handlers listen. Default {@link BASE_URL}. */
  baseUrl?: string;
  /** What Mark delivered writes into a job. Default `makeJobDelivery()`. */
  delivery?: JobDelivery;
  /**
   * The delivered videos whose job is gone (their folder was deleted), which the payment and Not
   * delivered yet routes still know. Like `jobs`, the array is changed as the server's rows
   * change; `GET /api/deliveries/unpaid-without-job` lists its unpaid entries.
   */
  orphans?: OrphanDelivery[];
}

/**
 * MSW handlers for the four delivery routes (`deliver`, `undeliver`, `POST /api/payments` and
 * `…/undo`), answering the way the server does when the request is allowed: Mark delivered gives
 * the job `options.delivery`, Not delivered yet takes it away, Mark paid and Not paid yet set and
 * clear its `paidOn` and `paidAmount` (the amount sent for it, else its price). They act on the `jobs` the test passes in (replacing the entries as the
 * server's rows change), 404 an unknown job, and answer 409 for a payment on a job that is not
 * delivered. A video in `options.orphans` has no job: Mark paid and Not paid yet answer it in
 * `orphans`, Not delivered yet answers `{ removed }` and deletes it. A test that needs another
 * answer puts its own handler first with `server.use`.
 */
export function deliveryHandlers(
  jobs: Job[],
  { baseUrl = BASE_URL, delivery = makeJobDelivery(), orphans = [] }: DeliveryHandlersOptions = {},
): RequestHandler[] {
  const error = (message: string, status: number) =>
    HttpResponse.json({ error: message }, { status });
  const find = (id: string) => jobs.find((job) => job.id === id);
  const findOrphan = (id: string) => orphans.find((orphan) => orphan.id === id);
  /** Replaces the job's delivery and answers with the job as it is then. */
  const change = (job: Job, next: JobDelivery | null): Job => {
    const changed = { ...job, delivery: next };
    jobs.splice(jobs.indexOf(job), 1, changed);
    return changed;
  };
  /** What Mark paid sets: the day, and the amount sent for the video or else its price. */
  const paid = (
    id: string,
    delivery: JobDelivery,
    paidOn: string | null,
    amounts: Readonly<Record<string, number>>,
  ): JobDelivery => ({
    ...delivery,
    paidOn,
    paidAmount: paidOn === null ? null : (amounts[id] ?? delivery.price ?? null),
  });
  /** Mark paid or Not paid yet: the same for each job, all or nothing. */
  const pay = (ids: string[], paidOn: string | null, amounts: Record<string, number> = {}) => {
    const found = ids.map((id) => ({ id, job: find(id), orphan: findOrphan(id) }));
    const unknown = found.find(({ job, orphan }) => job === undefined && orphan === undefined);
    if (unknown) return error(`Job ${unknown.id} not found`, 404);
    const undelivered = found.find(({ job }) => job !== undefined && job.delivery == null);
    if (undelivered) return error(`Job ${undelivered.id} is not delivered yet.`, 409);
    return HttpResponse.json({
      jobs: found.flatMap(({ job }) =>
        job?.delivery ? [change(job, paid(job.id, job.delivery, paidOn, amounts))] : [],
      ),
      orphans: found.flatMap(({ job, orphan }) => {
        if (job !== undefined || orphan === undefined) return [];
        const changed = { ...orphan, delivery: paid(orphan.id, orphan.delivery, paidOn, amounts) };
        orphans.splice(orphans.indexOf(orphan), 1, changed);
        return [changed];
      }),
    });
  };

  return [
    http.post(`${baseUrl}/api/jobs/:id/deliver`, ({ params }) => {
      const job = find(String(params.id));
      return job ? HttpResponse.json(change(job, delivery)) : error('Job not found', 404);
    }),
    http.post(`${baseUrl}/api/jobs/:id/undeliver`, ({ params }) => {
      const job = find(String(params.id));
      if (job) return HttpResponse.json(change(job, null));
      const orphan = findOrphan(String(params.id));
      if (!orphan) return error('Job not found', 404);
      orphans.splice(orphans.indexOf(orphan), 1);
      return HttpResponse.json({ removed: orphan });
    }),
    http.get(`${baseUrl}/api/deliveries/unpaid-without-job`, () =>
      HttpResponse.json({
        orphans: orphans.filter((orphan) => orphan.delivery.paidOn === null),
      }),
    ),
    http.post(`${baseUrl}/api/payments`, async ({ request }) => {
      const body = (await request.json()) as MarkPaidRequest;
      return pay(body.jobIds, body.paidOn, body.amounts);
    }),
    http.post(`${baseUrl}/api/payments/undo`, async ({ request }) => {
      const body = (await request.json()) as UndoPaidRequest;
      return pay(body.jobIds, null);
    }),
  ];
}

/**
 * A valid answer of `GET /api/money` for October 2026, built the way the board's numbers go: three
 * jobs at ₪200 (one with two ₪7.50 clips), Claude $200 and a music library at ₪49. Income 5,200
 * (September 4,400), expenses 960.4 (937.9), profit 4,239.6 (3,462.1). Override any part.
 */
export function makeMoneyResponse(overrides: Partial<MoneyResponse> = {}): MoneyResponse {
  const clip = (item: string, ils: number) => ({
    date: '2026-10-14',
    item,
    what: 'Clip licence #4831',
    amountLabel: '₪7.50',
    ils,
    job: 'Kova Coffee/Barista reel',
  });
  const job = (id: string, name: string, client: string, expenses: number) => ({
    jobId: id,
    name,
    client,
    clientId: `${id}client`,
    deliveredAt: '2026-10-05T09:00:00.000Z',
    listedAt: '2026-10-05T09:00:00.000Z',
    paidOn: null,
    archived: false,
    income: 200,
    expenses,
    profit: 200 - expenses,
    reviewSec: 600,
    charges: expenses > 0 ? [clip('Stock footage', 7.5), clip('Stock footage', 7.5)] : [],
  });
  return {
    month: '2026-10',
    months: ['2026-10', '2026-09', '2026-08'],
    banners: {
      income: {
        value: 5200,
        previous: 4400,
        history: [3200, 3600, 3400, 3800, 4000, 3800, 4400, 5200],
        // The three jobs of the ledger are all unpaid, at ₪200 each.
        unpaid: { value: 600, count: 3 },
      },
      expenses: {
        value: 960.4,
        previous: 937.9,
        history: [900, 910, 905, 930, 940, 935, 937.9, 960.4],
      },
      profit: {
        value: 4239.6,
        previous: 3462.1,
        history: [2300, 2690, 2495, 2870, 3060, 2865, 3462.1, 4239.6],
      },
    },
    ledger: [
      job('a1', 'Barista reel', 'Kova Coffee', 15),
      job('a2', 'Morning flow', 'Lumen Yoga', 0),
      job('a3', 'חלות לשבת', 'מאפיית הצפון', 0),
    ],
    subscriptions: [
      { id: 'claude', name: 'Claude Max plan', ils: 740 },
      { id: 'music', name: 'Music library', ils: 49 },
    ],
    expenses: {
      items: [
        {
          id: 'claude',
          name: 'Claude Max plan',
          kind: 'Subscription',
          billing: 'Monthly · renews Nov 12',
          amountLabel: '$200.00',
          ils: 740,
          charges: [
            {
              date: '2026-10-12',
              item: 'Claude Max plan',
              what: 'Monthly plan',
              amountLabel: '$200.00',
              ils: 740,
              job: null,
            },
          ],
          notes: [],
        },
      ],
      charges: [
        {
          date: '2026-10-12',
          item: 'Claude Max plan',
          what: 'Monthly plan',
          amountLabel: '$200.00',
          ils: 740,
          job: null,
        },
      ],
      total: 960.4,
      usdToIls: 3.7,
    },
    moneyFile: { status: 'ok', issue: null },
    ...overrides,
  };
}

/** A valid unsent text note (the same defaults as packages/shared's test fixtures). */
export function makeReviewNote(overrides: Partial<ReviewNote> = {}): ReviewNote {
  return {
    id: 'n1',
    jobId: 'a1b2c3d4e5f6',
    round: null,
    atSec: 2.4,
    kind: 'text',
    text: 'The title goes too fast.',
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: false,
    addToSeries: false,
    createdAt: '2026-10-20T14:00:00.000Z',
    sentAt: null,
    routeStatus: null,
    route: null,
    format: null,
    fixId: null,
    fixedAt: null,
    ...overrides,
  };
}

// --- series (the same defaults as packages/shared's test fixtures: the real case of the plan) ---

/** The client of the series fixtures and its id. */
export const SERIES_CLIENT = { clientId: '4b16f268bd46', client: 'עו״ד דוד לוי' } as const;

/** A valid `ready` series, "מיתוס או אמת", its format from episode 5. Override what a test cares about. */
export function makeSeries(overrides: Partial<Series> = {}): Series {
  return {
    id: '622212180eef',
    ...SERIES_CLIENT,
    name: 'מיתוס או אמת',
    state: 'ready',
    error: null,
    version: 1,
    formatJobId: '947ef344672b',
    formatJob: 'מיתוס או אמת 5',
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:04:00.000Z',
    pass: null,
    ...overrides,
  };
}

/** One valid series per state, as the server fills it for that state. */
export const seriesByState = {
  learning: makeSeries({
    state: 'learning',
    version: 0,
    updatedAt: '2026-10-21T10:00:00.000Z',
    pass: {
      kind: 'series',
      mode: 'start',
      fileCount: 0,
      jobId: '947ef344672b',
      job: 'מיתוס או אמת 5',
    },
  }),
  ready: makeSeries(),
  failed: makeSeries({
    state: 'failed',
    version: 0,
    error: 'Series stopped: series.md.new was not written.',
  }),
} satisfies Record<Series['state'], Series>;

/** The client page's line for {@link makeSeries}: episodes 5 and 6. */
export function makeSeriesSummary(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  const { id, name, state, error, formatJobId, formatJob, version, updatedAt } = makeSeries();
  return {
    id,
    name,
    state,
    error,
    formatJobId,
    formatJob,
    version,
    updatedAt,
    episodeCount: 2,
    lastEpisodeAt: '2026-10-21T11:00:00.000Z',
    ...overrides,
  };
}

/** `GET /api/series/:seriesId` for {@link makeSeries}: the series and its series.md. */
export function makeSeriesResponse(overrides: Partial<SeriesResponse> = {}): SeriesResponse {
  return {
    series: makeSeries(),
    markdown: [
      '# Series: מיתוס או אמת',
      '',
      'Format from מיתוס או אמת 5 (21 Oct 2026). Fonts, colours and captions come from the client style.',
      '',
      '## Flow',
      '',
      '- 0:00 · Hook: the myth typed on screen, news music in',
      '- 0:03 · Stamp: a red “מיתוס” stamp lands on the title',
      '',
    ].join('\n'),
    ...overrides,
  };
}

/** The format job of {@link makeSeries}: episode 5, ready. */
export function makeFormatJob(overrides: Partial<Job> = {}): Job {
  return makeJob({
    ...SERIES_CLIENT,
    id: '947ef344672b',
    name: 'מיתוס או אמת 5',
    relPath: 'עו״ד דוד לוי/מיתוס או אמת 5',
    state: 'ready',
    step: 8,
    placeInLine: null,
    output: {
      fileName: 'עו״ד דוד לוי/מיתוס או אמת 5.mp4',
      durationSec: 52.4,
      width: 1080,
      height: 1920,
      sizeBytes: 48_234_496,
    },
    approvedAt: '2026-10-21T09:30:00.000Z',
    seriesId: '622212180eef',
    episode: 5,
    ...overrides,
  });
}

/** An episode of {@link makeSeries}: "מיתוס או אמת 6", queued. */
export function makeEpisodeJob(overrides: Partial<Job> = {}): Job {
  return makeJob({
    ...SERIES_CLIENT,
    id: '6554b401d32d',
    name: 'מיתוס או אמת 6',
    relPath: 'עו״ד דוד לוי/מיתוס או אמת 6',
    seriesId: '622212180eef',
    episode: 6,
    ...overrides,
  });
}

// --- graphics (the same defaults as packages/shared's test fixtures) ----------------------------

/** The graphic fixtures' graphic id (12 hex). */
export const GRAPHIC_ID = '3f9a1c2b7d4e';

/** A ready lower third at v2: "Name on a white pill". */
export function makeGraphicSummary(overrides: Partial<GraphicSummary> = {}): GraphicSummary {
  return {
    id: GRAPHIC_ID,
    name: 'Name on a white pill',
    kind: 'lower-third',
    lengthSec: 3,
    version: 2,
    uses: true,
    status: 'ready',
    makingVersion: null,
    failedVersion: null,
    updatedAt: '2026-10-22T10:04:00.000Z',
    ...overrides,
  };
}

/** Claude's row that made v1. */
export function makeGraphicMessage(overrides: Partial<GraphicMessage> = {}): GraphicMessage {
  return {
    id: 'm-claude-1',
    role: 'claude',
    text: 'Made v1. A white pill with the name in Heebo Bold.',
    refs: [],
    effort: null,
    version: 1,
    status: 'done',
    step: null,
    error: null,
    startedAt: '2026-10-22T10:00:01.000Z',
    endedAt: '2026-10-22T10:02:00.000Z',
    createdAt: '2026-10-22T10:00:01.000Z',
    ...overrides,
  };
}

/** {@link makeGraphicSummary}'s page: The owner's first message and the row that made v1. */
export function makeGraphicDetail(overrides: Partial<GraphicDetail> = {}): GraphicDetail {
  return {
    ...makeGraphicSummary(),
    when: 'The first time a person is named on camera.',
    whenEdited: false,
    variables: [{ id: 'name', label: 'Name', default: 'דנה לוי' }],
    usedIn: null,
    folder: 'Name on a white pill',
    createdAt: '2026-10-22T10:00:00.000Z',
    messages: [
      makeGraphicMessage({
        id: 'm-you-1',
        role: 'you',
        text: 'A lower third: the name on a white pill.',
        refs: ['pill.png'],
        effort: 'xhigh',
        version: null,
        status: null,
        startedAt: null,
        endedAt: null,
        createdAt: '2026-10-22T10:00:00.000Z',
      }),
      makeGraphicMessage(),
    ],
    ...overrides,
  };
}

// --- LUTs (the same defaults as packages/shared's test fixtures) --------------------------------

/** A LUT of Yours, a look at 33 points that three jobs used. */
export function makeLutSummary(overrides: Partial<LutSummary> = {}): LutSummary {
  return {
    slug: 'golden-hour-warm',
    name: 'Golden Hour Warm',
    kind: 'look',
    size: 33,
    owner: 'yours',
    used: 3,
    usedLabel: '3 jobs',
    addedAt: '2026-10-22T10:00:00.000Z',
    isNew: false,
    ...overrides,
  };
}

/** A built-in LUT: no added time, never new. */
export function makeBuiltInLutSummary(overrides: Partial<LutSummary> = {}): LutSummary {
  return makeLutSummary({
    slug: 'film-contrast',
    name: 'Film contrast',
    owner: 'builtIn',
    used: 0,
    usedLabel: 'Used by the cinematic look',
    addedAt: null,
    ...overrides,
  });
}

/** {@link makeLutSummary} with its pane's fields. */
export function makeLutDetail(overrides: Partial<LutDetail> = {}): LutDetail {
  return {
    ...makeLutSummary(),
    description: 'Gold-amber highlights over slightly cool shadows.',
    note: null,
    file: 'Golden Hour Warm.cube',
    sizeLabel: '33 × 33 × 33',
    bytes: 1_468_006,
    usedIn: null,
    ...overrides,
  };
}

// --- Fonts (the same defaults as packages/shared's test fixtures) --------------------------------

/** Heebo Bold, one of nine faces in one file. */
export function makeFontFace(overrides: Partial<FontFaceInfo> = {}): FontFaceInfo {
  return {
    name: 'Heebo Bold',
    family: 'Heebo',
    weight: 700,
    italic: false,
    fileId: '3f9a1c7e5b20',
    bytes: 46_000,
    format: 'ttf',
    ...overrides,
  };
}

/** Heebo: Hebrew + English, Sans, all nine weights, used by 14 jobs. */
export function makeFontFamilySummary(
  overrides: Partial<FontFamilySummary> = {},
): FontFamilySummary {
  return {
    slug: 'heebo',
    name: 'Heebo',
    he: true,
    style: 'Sans',
    weights: [100, 200, 300, 400, 500, 600, 700, 800, 900],
    weightsLabel: '9 weights',
    used: 14,
    usedLabel: '14 jobs',
    addedAt: '2026-10-22T10:07:00.000Z',
    isNew: false,
    ...overrides,
  };
}

/** {@link makeFontFamilySummary} with its pane's fields: one Bold face of one file. */
export function makeFontFamilyDetail(overrides: Partial<FontFamilyDetail> = {}): FontFamilyDetail {
  return {
    ...makeFontFamilySummary(),
    faces: [makeFontFace()],
    files: 9,
    bytes: 420_000,
    usedIn: 14,
    ...overrides,
  };
}

/** A note of the job "Horizon FPV" asked for Gotham Bold, which the library does not have. */
export function makeFontRequest(overrides: Partial<FontRequest> = {}): FontRequest {
  return {
    id: 'a3c19e0b7d44',
    name: 'Gotham Bold',
    jobId: 'a1b2c3d4e5f6',
    jobName: 'Horizon FPV',
    round: 1,
    at: '2026-10-24T09:30:00.000Z',
    ...overrides,
  };
}

/** A new family in an import, three files of Hebrew + English. */
export function makeFontStageItem(overrides: Partial<FontStageItem> = {}): FontStageItem {
  return {
    id: 'karantina',
    name: 'Karantina',
    files: 3,
    he: true,
    weights: [300, 400, 700],
    bytes: 210_000,
    status: 'new',
    info: '3 files · Hebrew + English · 0.2 MB',
    ...overrides,
  };
}

/** A query client for tests: nothing retries, nothing is garbage-collected under the test. */
// --- Soundtrack (the same example as packages/shared's fixtures: Horizon FPV / Demo) ---------------

/** The plan page's example: 39 s, a big drop at 0:18 on a 120 BPM grid. */
export function makeMusicPlan(overrides: Partial<MusicPlan> = {}): MusicPlan {
  return {
    lengthMs: 39_000,
    styles: ['intense cinematic electronic', '120 BPM', 'big drop', 'instrumental'],
    avoid: ['vocals', 'singing', 'lyrics'],
    sections: [
      { name: 'Build', ms: 10_000, styles: ['sparse pulse', 'rising'], avoid: [] },
      { name: 'Rise', ms: 8_000, styles: ['risers', 'snare roll'], avoid: [] },
      { name: 'Drop', ms: 6_000, styles: ['full drop', 'sub bass'], avoid: [] },
      { name: 'Golden', ms: 10_000, styles: ['wide pads', 'steady beat'], avoid: [] },
      { name: 'Logo', ms: 5_000, styles: ['hit', 'tail'], avoid: [] },
    ],
    describe:
      'Intense cinematic electronic, 120 BPM. Builds to a big drop at 0:18 and lands on the logo at 0:35.',
    ...overrides,
  };
}

/** Cut `n` of a job's preview versions (Cut 1 is the first edit; each is a round further). */
export function makeJobVersion(n = 1, overrides: Partial<JobVersion> = {}): JobVersion {
  return {
    n,
    round: n - 1,
    createdAt: `2026-10-22T14:${String(40 + Math.min(n, 9)).padStart(2, '0')}:00.000Z`,
    durationSec: 42,
    width: 1080,
    height: 1920,
    current: false,
    ...overrides,
  };
}

/** Version `n` of the example, made by the edit run. */
export function makeMusicVersion(n = 1, overrides: Partial<MusicVersion> = {}): MusicVersion {
  return {
    id: `v${n}`,
    file: `v${n}.mp3`,
    describe: makeMusicPlan().describe,
    ask: null,
    seed: 4710 + n,
    model: 'music_v2_5',
    lengthMs: 39_000,
    by: 'edit',
    madeAt: `2026-10-23T09:0${Math.min(n, 9)}:00.000Z`,
    ...overrides,
  };
}

/** A made record: v1 by the edit run, picked. */
export function makeMusicRecord(overrides: Partial<MusicRecord> = {}): MusicRecord {
  return {
    v: 1,
    source: 'made',
    reason: null,
    file: null,
    plan: makeMusicPlan(),
    picked: 'v1',
    versions: [makeMusicVersion(1)],
    picks: [{ id: 'v1', at: '2026-10-23T09:01:00.000Z' }],
    making: null,
    failure: null,
    song: null,
    songFailure: null,
    ...overrides,
  };
}

/** `GET /api/jobs/:id/music` for a made record, Make another allowed. */
export function makeMusicView(overrides: Partial<MusicView> = {}): MusicView {
  return {
    ...makeMusicRecord(),
    canMake: true,
    whyNot: null,
    rev: 1_792_700_000_000,
    ...overrides,
  };
}

/** A generated job making its clips: voice, looks and keyframes done, 4 of 6 clips, $1.65 of $3. */
export function makeGenerateState(overrides: Partial<GenerateState> = {}): GenerateState {
  return {
    phase: 'clips',
    counts: {
      voice: { done: 7, total: 7 },
      looks: { done: 3, total: 3 },
      keyframes: { done: 7, total: 7 },
      clips: { done: 4, total: 6 },
      belowBar: 0,
    },
    spendUsd: 1.65,
    budgetUsd: 3,
    ...overrides,
  };
}

/** The song of the Songs boards: Yael's screenshot, got from YouTube Music, 0:42 to 1:21 of 3:12. */
export function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    title: 'נתתי לך בית',
    artist: 'Ofek Adanek',
    version: null,
    asked: { from: 'screenshot', file: 'IMG_4412.PNG', url: null, by: 'brief' },
    source: {
      site: 'youtube-music',
      via: 'yt-dlp',
      url: 'https://music.youtube.com/watch?v=Zq3Rk1pXo9A',
      id: 'Zq3Rk1pXo9A',
    },
    fullMs: 192_000,
    part: { startMs: 42_000, endMs: 81_000, how: 'measured' },
    trending: null,
    file: 'song.mp3',
    instagramLine:
      'In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42.',
    gotAt: '2026-10-25T21:03:00.000Z',
    ...overrides,
  };
}

/** A song that could not be got: the reel link's downloader did not answer. */
export function makeSongFailure(overrides: Partial<SongFailure> = {}): SongFailure {
  return {
    asked: 'https://www.instagram.com/reel/DQx7mK2kF9a/',
    code: 'unavailable',
    message: 'The downloader didn’t answer, so ElevenLabs made the music instead.',
    at: '2026-10-25T21:03:00.000Z',
    ...overrides,
  };
}

/** `GET /api/jobs/:id/music` for a video whose music is the song (state 1 of board SGMusic): source and pick `song`, nothing made. */
export function makeSongView(overrides: Partial<MusicView> = {}): MusicView {
  return makeMusicView({
    source: 'song',
    plan: null,
    picked: 'song',
    versions: [],
    picks: [{ id: 'song', at: '2026-10-25T21:03:00.000Z' }],
    song: makeSong(),
    ...overrides,
  });
}

/**
 * A query client for tests. It knows who is asking: the admin, as on the owner's own Mac, so a test of a
 * page does not have to say so. A test of the editor's view puts `makeMe({ role: 'editor' })` in
 * under `ME_KEY`.
 */
export function createTestQueryClient(): QueryClient {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    mutations: { retry: false },
  });
  client.setQueryData(ME_KEY, makeMe());
  return client;
}

/** A test query client whose viewer is Yael, an editor (the admin-only parts are hidden). */
export function createEditorQueryClient(): QueryClient {
  const client = createTestQueryClient();
  client.setQueryData(ME_KEY, makeMe({ email: 'yael@example.com', name: 'Yael', role: 'editor' }));
  return client;
}

/** The answer of `GET /api/me`: The owner, the admin, unless `overrides` says otherwise. */
export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return { email: 'local', name: 'The owner', role: 'admin', ...overrides };
}

/** What `useJobs()` does in a component: keeps an observer on the jobs query. Returns "unmount". */
export function watchJobs(queryClient: QueryClient, api: Api): () => void {
  return new QueryObserver(queryClient, jobsQueryOptions(api)).subscribe(() => {});
}

export function cachedJobs(queryClient: QueryClient): Job[] | undefined {
  return queryClient.getQueryData<Job[]>(JOBS_KEY);
}

/** A promise settled from outside, to hold a mocked response until the test says go. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An EventSource the test drives: no network, no browser. */
export class FakeEventSource implements EventSourceLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly pingListeners: (() => void)[] = [];

  constructor(readonly url: string) {}

  addEventListener(_type: 'ping', listener: () => void): void {
    this.pingListeners.push(listener);
  }

  /** The server's heartbeat: an `event: ping`, which never reaches `onmessage`. */
  ping(): void {
    for (const listener of this.pingListeners) listener();
  }

  close(): void {
    this.closed = true;
  }

  /** The server sends a frame: an event, or raw text for a frame that is not one. */
  emit(event: ServerEvent | string): void {
    const data = typeof event === 'string' ? event : JSON.stringify(event);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The connection broke. */
  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

export function fakeEventSources() {
  const sources: FakeEventSource[] = [];
  const factory: EventSourceFactory = (url) => {
    const source = new FakeEventSource(url);
    sources.push(source);
    return source;
  };
  return {
    factory,
    sources,
    /** The newest source: the one that is (or would be) connected. */
    get latest(): FakeEventSource {
      const source = sources.at(-1);
      if (!source) throw new Error('No EventSource was opened');
      return source;
    },
  };
}

/** Timers the test runs by hand: records every delay asked for and fires them on request. */
export function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const delays: number[] = [];
  let next = 0;
  const timers: ReconnectTimers = {
    setTimeout(callback, ms) {
      next += 1;
      pending.set(next, { callback, ms });
      delays.push(ms);
      return next;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    /** Every delay ever scheduled, in order. */
    delays,
    get pendingCount() {
      return pending.size;
    },
    /** Fires the oldest pending timer. */
    fire(): void {
      const first = pending.entries().next();
      if (first.done) throw new Error('No timer is pending');
      const [handle, { callback }] = first.value;
      pending.delete(handle);
      callback();
    },
  };
}

/** A valid `GET /api/team` answer: Yael and Amit (editors), with Arc Fitness assigned to Yael. */
export function makeTeam(overrides: Partial<TeamResponse> = {}): TeamResponse {
  return {
    users: [
      { email: 'yael@example.com', name: 'Yael', role: 'editor' },
      { email: 'amit@example.com', name: 'Amit', role: 'editor' },
    ],
    assignments: {
      aaaaaaaaaaaa: { client: 'Arc Fitness', editors: ['yael@example.com'] },
    },
    ...overrides,
  };
}
