// Typed fetch wrappers for the series API (Series plan §5), one per route, built like api.ts's:
// every answer is parsed with the shared schemas, and every failure is an `ApiError` carrying the
// server's words (a 409 or 422 says why, in SERIES_MESSAGES or seriesNameProblem's terms). While
// the Series switch is off every route answers 404 "Series are off."; the page asks
// `useSeriesEnabled` first and shows nothing of series then.

import {
  type ClientSeriesResponse,
  clientSeriesResponseSchema,
  type Job,
  type SeriesActionResponse,
  type SeriesFormatRequest,
  type SeriesResponse,
  type SetJobSeriesRequest,
  type StartSeriesRequest,
  seriesActionResponseSchema,
  seriesResponseSchema,
  setJobSeriesResponseSchema,
  undoSeriesResponseSchema,
} from '@studio/shared';
import { createJsonClient, type JsonClientOptions } from './api';

export interface SeriesApi {
  /** `GET /api/clients/:clientId/series`: the client's series, by name, with their episode counts. */
  listClientSeries(clientId: string, signal?: AbortSignal): Promise<ClientSeriesResponse>;
  /**
   * `GET /api/series/:seriesId`: the series and its series.md (`markdown` is `null` while there is
   * none). Rejects with an `ApiError` 404 for a series the engine does not know.
   */
  getSeries(seriesId: string, signal?: AbortSignal): Promise<SeriesResponse>;
  /**
   * `POST /api/jobs/:jobId/series`: Start a series from this Ready job, named `name`. Answers (202)
   * with the series, now learning. Rejects with an `ApiError`: 409 when the job is not ready, is in
   * a series already, or while the client's style or a series of it is being learned; 422 for a
   * name that can't be used or is taken (the dialog shows it under the input).
   */
  startSeries(jobId: string, name: string, signal?: AbortSignal): Promise<SeriesActionResponse>;
  /**
   * `POST /api/series/:seriesId/format`: Use as the series format. Answers (202) with the series,
   * now learning. 409 unless the job is a ready episode of the series that is not its format yet.
   */
  useAsFormat(seriesId: string, jobId: string, signal?: AbortSignal): Promise<SeriesActionResponse>;
  /**
   * `PUT /api/jobs/:jobId/series`: puts a job that has not started in the series (`null`: "Not in
   * a series") and answers with the job. 409 once the job has started.
   */
  setJobSeries(jobId: string, seriesId: string | null, signal?: AbortSignal): Promise<Job>;
  /** `POST /api/series/:seriesId/undo`: the toast's Undo of Start a series. 409 after 10 s. */
  undoSeries(seriesId: string, signal?: AbortSignal): Promise<void>;
  /** `POST /api/series/:seriesId/retry`: runs the failed series pass again. 409 unless it failed. */
  retrySeries(seriesId: string, signal?: AbortSignal): Promise<SeriesActionResponse>;
}

function seriesPath(seriesId: string): string {
  return `/api/series/${encodeURIComponent(seriesId)}`;
}

function jobSeriesPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/series`;
}

/** A request with a JSON body. */
function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

export function createSeriesApi(options: JsonClientOptions = {}): SeriesApi {
  const { request, parse } = createJsonClient(options);

  return {
    async listClientSeries(clientId, signal) {
      const path = `/api/clients/${encodeURIComponent(clientId)}/series`;
      return parse(clientSeriesResponseSchema, await request(path, { signal }));
    },
    async getSeries(seriesId, signal) {
      return parse(seriesResponseSchema, await request(seriesPath(seriesId), { signal }));
    },
    async startSeries(jobId, name, signal) {
      const body: StartSeriesRequest = { name };
      const answer = await request(jobSeriesPath(jobId), jsonInit('POST', body, signal));
      return parse(seriesActionResponseSchema, answer);
    },
    async useAsFormat(seriesId, jobId, signal) {
      const body: SeriesFormatRequest = { jobId };
      const answer = await request(
        `${seriesPath(seriesId)}/format`,
        jsonInit('POST', body, signal),
      );
      return parse(seriesActionResponseSchema, answer);
    },
    async setJobSeries(jobId, seriesId, signal) {
      const body: SetJobSeriesRequest = { seriesId };
      const answer = await request(jobSeriesPath(jobId), jsonInit('PUT', body, signal));
      return parse(setJobSeriesResponseSchema, answer);
    },
    async undoSeries(seriesId, signal) {
      const answer = await request(`${seriesPath(seriesId)}/undo`, { method: 'POST', signal });
      parse(undoSeriesResponseSchema, answer);
    },
    async retrySeries(seriesId, signal) {
      const answer = await request(`${seriesPath(seriesId)}/retry`, { method: 'POST', signal });
      return parse(seriesActionResponseSchema, answer);
    },
  };
}

/** The app's series client: same origin. Hooks use this one; tests build their own with `createSeriesApi`. */
export const seriesApi: SeriesApi = createSeriesApi();
