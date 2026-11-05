import { type HealthResponse, MUSIC_MESSAGES, type MusicView } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api';
import { HEALTH_KEY, musicEnabled } from './health-query';
import { createJobEventsClient } from './job-events';
import {
  applyJobMusic,
  MUSIC_KEY,
  musicKey,
  musicQueryOptions,
  useJobMusic,
  useMusicEnabled,
  useSongsEnabled,
} from './music-query';
import {
  BASE_URL,
  createTestQueryClient,
  fakeEventSources,
  makeMusicView,
  manualTimers,
} from './test-utils';

// A job's music as the page holds it (Soundtrack, SD0): the three calls, the ['music', jobId]
// query, the switch that keeps it from asking anything while music is off, and the job.music event.

const JOB = 'a1b2c3d4e5f6';

const health: HealthResponse = {
  ok: true,
  version: '0.25.0',
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

describe('the music calls', () => {
  it('GETs /api/jobs/:id/music, with the id escaped, and reads a job without music as null', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/music`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json(seen.length === 1 ? makeMusicView() : null);
      }),
    );
    await expect(api.getJobMusic(JOB)).resolves.toEqual(makeMusicView());
    await expect(api.getJobMusic('a/b c')).resolves.toBeNull();
    expect(seen).toEqual([`/api/jobs/${JOB}/music`, '/api/jobs/a%2Fb%20c/music']);
  });

  it('POSTs Make another with the words, or with none', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB}/music`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          makeMusicView({ making: { id: 'v2', ask: null, startedAt: '2026-10-23T09:05:00.000Z' } }),
          { status: 202 },
        );
      }),
    );
    await expect(api.makeMusic(JOB, 'darker, more drums')).resolves.toMatchObject({
      making: { id: 'v2' },
    });
    await api.makeMusic(JOB);
    expect(bodies).toEqual([{ ask: 'darker, more drums' }, {}]);
  });

  it('PUTs a pick', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${BASE_URL}/api/jobs/${JOB}/music/pick`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(makeMusicView({ picked: 'off' }));
      }),
    );
    await expect(api.pickMusic(JOB, 'off')).resolves.toMatchObject({ picked: 'off' });
    expect(bodies).toEqual([{ id: 'off' }]);
  });

  it('keeps the server’s words of a refusal: off, and not in review', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/music`, () =>
        HttpResponse.json({ error: MUSIC_MESSAGES.off }, { status: 404 }),
      ),
      http.post(`${BASE_URL}/api/jobs/:id/music`, () =>
        HttpResponse.json({ error: MUSIC_MESSAGES.notInReview }, { status: 409 }),
      ),
    );
    await expect(api.getJobMusic(JOB)).rejects.toMatchObject({
      status: 404,
      message: MUSIC_MESSAGES.off,
    });
    await expect(api.makeMusic(JOB)).rejects.toMatchObject({
      status: 409,
      message: MUSIC_MESSAGES.notInReview,
    });
  });

  it('rejects an answer that is not a job’s music', async () => {
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/music`, () =>
        HttpResponse.json({ ...makeMusicView(), rev: undefined }),
      ),
    );
    await expect(api.getJobMusic(JOB)).rejects.toMatchObject({ name: 'ApiError', status: 200 });
  });
});

describe('the switch', () => {
  function Enabled() {
    return <p>{String(useMusicEnabled())}</p>;
  }

  it('is off until the health answer says on', () => {
    expect(musicEnabled(undefined)).toBe(false);
    expect(musicEnabled(health)).toBe(false);
    expect(musicEnabled({ ...health, music: true })).toBe(true);
    expect(render(<Enabled />)).toBe('<p>false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, music: true });
    expect(render(<Enabled />)).toBe('<p>true</p>');
  });
});

describe('the Songs switch', () => {
  function Enabled() {
    return <p>{String(useSongsEnabled())}</p>;
  }

  it('is off until the health answer says songs and music are on', () => {
    expect(render(<Enabled />)).toBe('<p>false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, music: true });
    expect(render(<Enabled />)).toBe('<p>false</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, music: true, songs: true });
    expect(render(<Enabled />)).toBe('<p>true</p>');
    queryClient.setQueryData(HEALTH_KEY, { ...health, music: false, songs: true });
    expect(render(<Enabled />)).toBe('<p>false</p>');
  });
});

describe('useJobMusic', () => {
  function Music({ enabled }: { enabled?: boolean }) {
    const music = useJobMusic(JOB, { enabled });
    const data = music.data === undefined ? 'undefined' : music.data === null ? 'null' : 'view';
    return <p>{`${data} ${music.fetchStatus}`}</p>;
  }

  it('asks nothing while music is off, even with a cached answer', () => {
    queryClient.setQueryData(HEALTH_KEY, health);
    expect(render(<Music />)).toBe('<p>undefined idle</p>');
  });

  it('shows the cached answer while music is on', () => {
    queryClient.setQueryData(HEALTH_KEY, { ...health, music: true });
    applyJobMusic(queryClient, JOB, null);
    expect(render(<Music />)).toBe('<p>null idle</p>');
    applyJobMusic(queryClient, JOB, makeMusicView());
    expect(render(<Music />)).toBe('<p>view idle</p>');
  });

  it('loads the music once asked, and does not ask again after a 4xx', async () => {
    let asked = 0;
    server.use(
      http.get(`${BASE_URL}/api/jobs/:id/music`, () => {
        asked += 1;
        return HttpResponse.json({ error: MUSIC_MESSAGES.off }, { status: 404 });
      }),
    );
    const options = musicQueryOptions(api, JOB);
    expect(options.queryKey).toEqual(musicKey(JOB));
    expect(musicKey(JOB).slice(0, 1)).toEqual([...MUSIC_KEY]);
    const error = await queryClient.fetchQuery(options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const retry = options.retry as (count: number, error: ApiError) => boolean;
    expect(retry(0, new ApiError(404, MUSIC_MESSAGES.off))).toBe(false);
    expect(retry(0, new ApiError(0, 'down'))).toBe(true);
    expect(asked).toBe(1);
  });
});

describe('the job.music event', () => {
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
  const cached = () => queryClient.getQueryData<MusicView | null>(musicKey(JOB));

  it('writes the music it carries into the cache, null too', () => {
    const { sources, onUnreadableEvent } = start();
    const music = makeMusicView({ picked: 'off', rev: 7 });
    sources.latest.emit({ type: 'job.music', jobId: JOB, music });
    expect(onUnreadableEvent).not.toHaveBeenCalled();
    expect(cached()).toEqual(music);
    sources.latest.emit({ type: 'job.music', jobId: JOB, music: null });
    expect(cached()).toBeNull();
  });

  it('is invalidated by a hello and dropped with its job', () => {
    applyJobMusic(queryClient, JOB, makeMusicView());
    const { sources } = start();
    sources.latest.emit({ type: 'hello' });
    expect(queryClient.getQueryState(musicKey(JOB))?.isInvalidated).toBe(true);
    sources.latest.emit({ type: 'job.remove', id: JOB });
    expect(cached()).toBeUndefined();
  });
});
