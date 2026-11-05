// Helpers shared by the series tests (K0, for the items that call or build on the series service).
// Not part of the server build (see tsconfig.build.json).

import type { Series } from '@studio/shared';
import type { StoredSeries } from '../db/index.js';
import type { SeriesChange, SeriesChangeListener, SeriesService } from './series-service.js';

/**
 * A valid `ready` series, the real case of the Series plan: "מיתוס או אמת" of עו״ד דוד לוי, its
 * format from episode 5, with the real ids (`clientIdFor`, `seriesIdFor`, `jobIdFor`). The same
 * values as packages/shared's fixtures. Override what a test cares about.
 */
export function makeSeries(overrides: Partial<Series> = {}): Series {
  return {
    id: '622212180eef',
    clientId: '4b16f268bd46',
    client: 'עו״ד דוד לוי',
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

/** {@link makeSeries} as the repository stores it: no `pass`, and the pass Retry would run. */
export function makeStoredSeries(overrides: Partial<StoredSeries> = {}): StoredSeries {
  const { pass: _pass, ...series } = makeSeries();
  return { ...series, lastPass: null, ...overrides };
}

/** The methods of the series service: those that answer a `SeriesOutcome`, and `approved`. */
export type SeriesMethod = Exclude<keyof SeriesService, 'enabled' | 'onChange'>;

/** One call the fake service received. */
export interface SeriesCall {
  method: SeriesMethod;
  args: unknown[];
}

/**
 * A series service for the tests of what calls it (the routes, Send's hook, the engine): on, and
 * each method answers with the function `answers` gives for it, or rejects ("no answer given")
 * when none is given, so a test notices a call it did not expect. Every call is recorded in
 * `calls`; `emit` announces a change to whoever listens with `onChange`.
 */
export function fakeSeriesService(answers: Partial<Pick<SeriesService, SeriesMethod>> = {}) {
  const calls: SeriesCall[] = [];
  const listeners = new Set<SeriesChangeListener>();

  function answer<M extends SeriesMethod>(method: M): SeriesService[M] {
    const given = answers[method] as ((...args: unknown[]) => unknown) | undefined;
    const call = (...args: unknown[]): unknown => {
      calls.push({ method, args });
      if (given === undefined) {
        return Promise.reject(new Error(`fakeSeriesService: no answer given for ${method}`));
      }
      return given(...args);
    };
    return call as SeriesService[M];
  }

  const service: SeriesService = {
    enabled: true,
    list: answer('list'),
    get: answer('get'),
    start: answer('start'),
    useAsFormat: answer('useAsFormat'),
    setJobSeries: answer('setJobSeries'),
    undoStart: answer('undoStart'),
    retry: answer('retry'),
    addNotes: answer('addNotes'),
    approved: answer('approved'),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    service,
    calls,
    /** Tells every `onChange` listener about `change`, as the real service does after a write. */
    emit(change: SeriesChange): void {
      for (const listener of [...listeners]) listener(change);
    },
    listenerCount: () => listeners.size,
  };
}
