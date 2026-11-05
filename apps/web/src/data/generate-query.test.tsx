import {
  GENERATE_MESSAGES,
  type GenerateState,
  type HealthResponse,
  type Job,
} from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import {
  applyJobGenerate,
  generateHistoryKey,
  JOB_GENERATE_KEY,
  jobGenerateKey,
  jobGenerateQueryOptions,
  useGenerateEnabled,
  useJobGenerate,
} from './generate-query';
import { generateEnabled, HEALTH_KEY } from './health-query';
import { createJobEventsClient } from './job-events';
import { JOBS_KEY } from './jobs-cache';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeGenerateState,
  makeJob,
  manualTimers,
} from './test-utils';

// A job's Generate stage as the page holds it (Generated videos, GN0): the call, the
// ['job-generate', jobId] query, the switch that keeps it from asking anything while the feature is
// off, and the job.generate event.

const JOB = 'a1b2c3d4e5f6';

const health: HealthResponse = {
  ok: true,
  version: '0.44.4',
  settleMs: 60_000,
  series: false,
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

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

describe('the generate call', () => {
  it('GETs /api/jobs/:id/generate, with the id escaped', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(makeGenerateState());
      }),
    );
    await expect(api.getJobGenerate(JOB)).resolves.toEqual(makeGenerateState());
    await api.getJobGenerate('a/b c');
    expect(seen).toEqual([`/api/jobs/${JOB}/generate`, '/api/jobs/a%2Fb%20c/generate']);
  });

  it('reads a job with no Generate stage as null, whatever the 404 says', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate`, ({ params }) =>
        params.id === 'off'
          ? HttpResponse.json({ error: GENERATE_MESSAGES.off }, { status: 404 })
          : HttpResponse.json({ error: GENERATE_MESSAGES.notGenerated }, { status: 404 }),
      ),
    );
    await expect(api.getJobGenerate(JOB)).resolves.toBeNull();
    await expect(api.getJobGenerate('off')).resolves.toBeNull();
  });

  it('keeps any other failure as an ApiError', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate`, () =>
        HttpResponse.json({ error: 'Internal server error' }, { status: 500 }),
      ),
    );
    await expect(api.getJobGenerate(JOB)).rejects.toMatchObject({ name: 'ApiError', status: 500 });
  });

  it('rejects an answer that is not a Generate state', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate`, () =>
        HttpResponse.json({ ...makeGenerateState(), phase: 'dreaming' }),
      ),
    );
    await expect(api.getJobGenerate(JOB)).rejects.toMatchObject({ name: 'ApiError', status: 200 });
  });
});

describe('the switch', () => {
  function Enabled() {
    return <p>{String(useGenerateEnabled())}</p>;
  }

  it('is off until the health answer says on, and for an engine from before Generated videos', () => {
    expect(generateEnabled(undefined)).toBe(false);
    expect(generateEnabled(health)).toBe(false);
    expect(generateEnabled({ ...health, generate: false })).toBe(false);
    expect(generateEnabled({ ...health, generate: true })).toBe(true);
    expect(render(<Enabled />)).toBe('<p>false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, generate: true });
    expect(render(<Enabled />)).toBe('<p>true</p>');
  });
});

describe('useJobGenerate', () => {
  function Generate({ enabled }: { enabled?: boolean }) {
    const generate = useJobGenerate(JOB, { enabled });
    const data =
      generate.data === undefined
        ? 'undefined'
        : generate.data === null
          ? 'null'
          : generate.data.phase;
    return <p>{`${data} ${generate.fetchStatus}`}</p>;
  }

  it('asks nothing while Generated videos are off, even with a cached answer', () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render(<Generate />)).toBe('<p>undefined idle</p>');
  });

  it('shows the cached answer while they are on', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, generate: true });
    applyJobGenerate(queryClient, JOB, makeGenerateState({ phase: 'voice' }));
    expect(render(<Generate />)).toBe('<p>voice idle</p>');
  });

  it('asks nothing for a job the page says is not worth asking about (enabled: false)', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, generate: true });
    expect(render(<Generate enabled={false} />)).toBe('<p>undefined idle</p>');
  });

  it('loads the state once asked, and does not ask again after a 4xx', async () => {
    let asked = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate`, () => {
        asked += 1;
        return HttpResponse.json(makeGenerateState());
      }),
    );
    const options = jobGenerateQueryOptions(api, JOB);
    expect(options.queryKey).toEqual(jobGenerateKey(JOB));
    expect(jobGenerateKey(JOB).slice(0, 1)).toEqual([...JOB_GENERATE_KEY]);
    expect(await queryClient.fetchQuery(options)).toEqual(makeGenerateState());
    expect(asked).toBe(1);
    const retry = options.retry as (count: number, error: ApiError) => boolean;
    expect(retry(0, new ApiError(404, 'x'))).toBe(false);
    expect(retry(0, new ApiError(0, 'down'))).toBe(true);
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('the history call (GN9)', () => {
  const EVENTS = [
    { kind: 'decided', at: '2026-10-21T14:00:00.000Z', formats: ['9:16', '1:1'] },
    { kind: 'stopped', at: '2026-10-21T14:21:00.000Z', code: 'balance_empty' },
  ];

  it('GETs /api/jobs/:id/generate/history, with the id escaped, and reads the events', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate/history`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ events: EVENTS });
      }),
    );
    await expect(api.getGenerateHistory(JOB)).resolves.toEqual(EVENTS);
    await api.getGenerateHistory('a/b c');
    expect(seen).toEqual([
      `/api/jobs/${JOB}/generate/history`,
      '/api/jobs/a%2Fb%20c/generate/history',
    ]);
  });

  it('reads a job with no Generate stage as no events, and keeps any other failure', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate/history`, ({ params }) =>
        params.id === 'bad'
          ? HttpResponse.json({ error: 'Internal server error' }, { status: 500 })
          : HttpResponse.json({ error: GENERATE_MESSAGES.notGenerated }, { status: 404 }),
      ),
    );
    await expect(api.getGenerateHistory(JOB)).resolves.toEqual([]);
    await expect(api.getGenerateHistory('bad')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('rejects an answer that is not a history', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate/history`, () =>
        HttpResponse.json({ events: [{ kind: 'dancing' }] }),
      ),
    );
    await expect(api.getGenerateHistory(JOB)).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('is asked again when the stage moves (job.generate invalidates it)', () => {
    queryClient.setQueryData(generateHistoryKey(JOB), EVENTS);
    expect(queryClient.getQueryState(generateHistoryKey(JOB))?.isInvalidated).toBe(false);
    applyJobGenerate(queryClient, JOB, makeGenerateState({ phase: 'done' }));
    expect(queryClient.getQueryState(generateHistoryKey(JOB))?.isInvalidated).toBe(true);
    // The stage's own state is not touched by it.
    expect(queryClient.getQueryState(jobGenerateKey(JOB))?.isInvalidated).toBe(false);
  });
});

describe('applyJobGenerate', () => {
  it('writes the state into the job’s query and into the cached job, and leaves the others alone', () => {
    const mine = makeJob({ id: JOB });
    const other = makeJob({ id: 'ffffffffffff' });
    queryClient.setQueryData<Job[]>(JOBS_KEY, [mine, other]);

    const state = makeGenerateState({ phase: 'sound' });
    applyJobGenerate(queryClient, JOB, state);

    expect(queryClient.getQueryData<GenerateState | null>(jobGenerateKey(JOB))).toEqual(state);
    const list = queryClient.getQueryData<Job[]>(JOBS_KEY);
    expect(list?.find((job) => job.id === JOB)?.generate).toEqual(state);
    expect(list?.find((job) => job.id === 'ffffffffffff')).toBe(other);
  });

  it('does not make a job list that was not loaded', () => {
    applyJobGenerate(queryClient, JOB, makeGenerateState());
    expect(queryClient.getQueryData(JOBS_KEY)).toBeUndefined();
  });
});

describe('the job.generate event', () => {
  function start() {
    const sources = fakeEventSources();
    const onUnreadableEvent = vi.fn();
    createJobEventsClient({
      queryClient,
      eventSourceFactory: sources.factory,
      timers: manualTimers().timers,
      onUnreadableEvent,
      page: null,
    }).start();
    return { sources, onUnreadableEvent };
  }
  const cached = () => queryClient.getQueryData<GenerateState | null>(jobGenerateKey(JOB));

  it('writes the state it carries into the cache, and into the job in the list', () => {
    queryClient.setQueryData<Job[]>(JOBS_KEY, [makeJob({ id: JOB })]);
    const { sources, onUnreadableEvent } = start();
    const generate = makeGenerateState({ phase: 'clips', spendUsd: 2.1 });

    sources.latest.emit({ type: 'job.generate', jobId: JOB, generate });

    expect(onUnreadableEvent).not.toHaveBeenCalled();
    expect(cached()).toEqual(generate);
    expect(queryClient.getQueryData<Job[]>(JOBS_KEY)?.[0]?.generate).toEqual(generate);
    const next = makeGenerateState({ phase: 'done', spendUsd: 2.33 });
    sources.latest.emit({ type: 'job.generate', jobId: JOB, generate: next });
    expect(cached()).toEqual(next);
  });

  it('is invalidated by a hello and dropped with its job', () => {
    applyJobGenerate(queryClient, JOB, makeGenerateState());
    const { sources } = start();
    sources.latest.emit({ type: 'hello' });
    expect(queryClient.getQueryState(jobGenerateKey(JOB))?.isInvalidated).toBe(true);
    sources.latest.emit({ type: 'job.remove', id: JOB });
    expect(cached()).toBeUndefined();
  });

  it('keeps the generate state a job.upsert carries', () => {
    queryClient.setQueryData<Job[]>(JOBS_KEY, [makeJob({ id: 'ffffffffffff' })]);
    const { sources } = start();
    const generate = makeGenerateState({ phase: 'voice' });
    sources.latest.emit({ type: 'hello' });
    sources.latest.emit({ type: 'job.upsert', job: makeJob({ id: JOB, generate }) });
    expect(
      queryClient.getQueryData<Job[]>(JOBS_KEY)?.find((job) => job.id === JOB)?.generate,
    ).toEqual(generate);
  });
});

describe('the review plan call (GN8)', () => {
  const PLAN = {
    clips: [{ id: 'B', usd: 0.51, windows: [{ startSec: 3, endSec: 8 }] }],
    lines: [{ id: 'L1', startSec: 3, endSec: 6.6 }],
  };

  it('GETs /api/jobs/:id/generate/review-plan, with the id escaped, and reads the plan', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate/review-plan`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(PLAN);
      }),
    );
    await expect(api.getGenerateReviewPlan(JOB)).resolves.toEqual(PLAN);
    await api.getGenerateReviewPlan('a/b c');
    expect(seen).toEqual([
      `/api/jobs/${JOB}/generate/review-plan`,
      '/api/jobs/a%2Fb%20c/generate/review-plan',
    ]);
  });

  it('reads a job with no hand-off as null, and keeps any other failure', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate/review-plan`, ({ params }) =>
        params.id === 'bad'
          ? HttpResponse.json({ error: 'Internal server error' }, { status: 500 })
          : HttpResponse.json({ error: GENERATE_MESSAGES.notGenerated }, { status: 404 }),
      ),
    );
    await expect(api.getGenerateReviewPlan(JOB)).resolves.toBeNull();
    await expect(api.getGenerateReviewPlan('bad')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('rejects an answer that is not a plan', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/generate/review-plan`, () =>
        HttpResponse.json({ clips: 'many' }),
      ),
    );
    await expect(api.getGenerateReviewPlan(JOB)).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
    });
  });
});
