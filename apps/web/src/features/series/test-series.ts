// Test data for the client page's Series list and the series page: the client of K0's fixtures
// (עו״ד דוד לוי) with its two series and the jobs that belong to them, over a query client that
// holds what the server would have sent. Not imported by the app.

import type { HealthResponse, Job, SeriesResponse, SeriesSummary } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { CLIENTS_KEY } from '@/data/clients-query';
import { HEALTH_KEY } from '@/data/health-query';
import { JOBS_KEY } from '@/data/jobs-cache';
import { clientSeriesKey, seriesKey } from '@/data/series-cache';
import {
  createTestQueryClient,
  makeEpisodeJob,
  makeFormatJob,
  makeJob,
  makeSeriesResponse,
  makeSeriesSummary,
  SERIES_CLIENT,
} from '@/data/test-utils';
import { clientRowsOf } from '@/features/clients/test-clients';

export { SERIES_CLIENT };

/** The id of the second series, "שאלות נפוצות". */
export const FAQ_SERIES_ID = 'b1b1b1b1b1b1';

const FAQ_FORMAT_ID = 'faq5faq5faq5';

/** "מיתוס או אמת": episodes 5 (the format, ready), 6 (queued) and 7 (editing). */
export const MYTH_JOBS: readonly Job[] = [
  makeFormatJob({ updatedAt: '2026-10-21T09:00:00.000Z', addedAt: '2026-10-21T08:00:00.000Z' }),
  makeEpisodeJob({ updatedAt: '2026-10-21T10:00:00.000Z', addedAt: '2026-10-21T09:30:00.000Z' }),
  makeEpisodeJob({
    id: 'myth7myth7ab',
    name: 'מיתוס או אמת 7',
    relPath: 'עו״ד דוד לוי/מיתוס או אמת 7',
    episode: 7,
    state: 'editing',
    step: 3,
    placeInLine: null,
    updatedAt: '2026-10-21T11:00:00.000Z',
    addedAt: '2026-10-21T10:55:00.000Z',
  }),
];

/** "שאלות נפוצות": one ready episode, the format. */
export const FAQ_JOBS: readonly Job[] = [
  makeFormatJob({
    id: FAQ_FORMAT_ID,
    name: 'שאלות נפוצות 5',
    relPath: 'עו״ד דוד לוי/שאלות נפוצות 5',
    seriesId: FAQ_SERIES_ID,
    updatedAt: '2026-10-21T08:30:00.000Z',
    addedAt: '2026-10-21T08:00:00.000Z',
  }),
];

/** A job of the client that is in no series, and one of another client. */
export const OTHER_JOBS: readonly Job[] = [
  makeJob({
    ...SERIES_CLIENT,
    id: 'plainjob0001',
    name: 'Intro reel',
    relPath: 'עו״ד דוד לוי/Intro reel',
    updatedAt: '2026-10-21T07:00:00.000Z',
    addedAt: '2026-10-21T06:00:00.000Z',
  }),
  makeJob({
    id: 'northwind001',
    updatedAt: '2026-10-21T12:00:00.000Z',
    addedAt: '2026-10-21T12:00:00.000Z',
  }),
];

export const SERIES_JOBS: readonly Job[] = [...MYTH_JOBS, ...FAQ_JOBS, ...OTHER_JOBS];

export const MYTH_SUMMARY: SeriesSummary = makeSeriesSummary({
  episodeCount: 3,
  lastEpisodeAt: '2026-10-21T10:55:00.000Z',
});

export const FAQ_SUMMARY: SeriesSummary = makeSeriesSummary({
  id: FAQ_SERIES_ID,
  name: 'שאלות נפוצות',
  formatJobId: FAQ_FORMAT_ID,
  formatJob: 'שאלות נפוצות 5',
  episodeCount: 1,
  lastEpisodeAt: '2026-10-21T08:00:00.000Z',
});

export const HEALTH: HealthResponse = {
  ok: true,
  version: '0.12.5',
  settleMs: 60_000,
  series: true,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

export interface SeriesWorldOptions {
  /** The Series switch. Default on. */
  on?: boolean;
  /** The client's series list; `null` leaves it unanswered. Default both series. */
  summaries?: readonly SeriesSummary[] | null;
  /** `GET /api/series/:id` for the "מיתוס או אמת" series; `null` leaves it unanswered. */
  detail?: SeriesResponse | null;
  jobs?: readonly Job[];
}

/** A query client that holds what the server would have sent for these options. */
export function seriesWorld({
  on = true,
  summaries = [MYTH_SUMMARY, FAQ_SUMMARY],
  detail = makeSeriesResponse(),
  jobs = SERIES_JOBS,
}: SeriesWorldOptions = {}): QueryClient {
  const client = createTestQueryClient();
  client.setQueryData(JOBS_KEY, jobs);
  client.setQueryData(CLIENTS_KEY, clientRowsOf(jobs));
  client.setQueryData(HEALTH_KEY, { ...HEALTH, series: on });
  if (summaries !== null) client.setQueryData(clientSeriesKey(SERIES_CLIENT.clientId), summaries);
  if (detail !== null) client.setQueryData(seriesKey(detail.series.id), detail);
  return client;
}
