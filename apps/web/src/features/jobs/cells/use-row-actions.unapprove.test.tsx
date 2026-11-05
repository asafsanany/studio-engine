// What a row does for Unapprove: the request goes to the server, the job is in Review at once, and
// a message says where it went once the server has answered. The routes are answered by MSW; the
// messages are sonner's, mocked. There is no DOM, so the hook is rendered once to take its actions.

import type { Job } from '@studio/shared';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS_KEY } from '@/data/jobs-cache';
import { BASE_URL, createTestQueryClient, makeJob } from '@/data/test-utils';

const sonner = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { error: vi.fn() });
  return { toast };
});
vi.mock('sonner', () => sonner);

const { useRowActions } = await import('./use-row-actions');
type RowActions = ReturnType<typeof useRowActions>;

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  // The data layer's `api` asks for relative addresses; MSW answers absolute ones.
  const interceptedFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    interceptedFetch(
      typeof input === 'string' && input.startsWith('/') ? `${BASE_URL}${input}` : input,
      init,
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  vi.unstubAllGlobals();
  server.close();
});

const approved: Job = makeJob({
  id: 'fpv',
  name: 'Maps Search',
  state: 'ready',
  step: 8,
  placeInLine: null,
  runKind: 'render',
  approvedAt: '2026-10-25T18:19:26.701Z',
  preview: { durationSec: 20.9, width: 1080, height: 1920 },
  output: {
    fileName: 'Falcon FPV/Maps Search.mp4',
    durationSec: 20.9,
    width: 1080,
    height: 1920,
    sizeBytes: 1,
  },
});
const inReview: Job = {
  ...approved,
  state: 'review',
  step: 7,
  runKind: 'edit',
  approvedAt: null,
  output: null,
};

let queryClient: QueryClient;
beforeEach(() => {
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [approved]);
});

function actionsFor(job: Job): RowActions {
  let actions: RowActions | undefined;
  function Capture() {
    actions = useRowActions(job);
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Capture />
    </QueryClientProvider>,
  );
  if (actions === undefined) throw new Error('the hook did not run');
  return actions;
}

describe('useRowActions: Unapprove', () => {
  it('posts to the unapprove route, then says the video is back in Review', async () => {
    const posted: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/fpv/unapprove`, ({ request }) => {
        posted.push(new URL(request.url).pathname);
        return HttpResponse.json(inReview);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([inReview])),
    );

    actionsFor(approved).run({ kind: 'unapprove', label: 'Unapprove' });

    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledOnce());
    expect(posted).toEqual(['/api/jobs/fpv/unapprove']);
    const [message, options] = sonner.toast.mock.calls[0] as [unknown, { id: string }];
    expect(renderToStaticMarkup(message as React.ReactElement)).toContain('Back in Review');
    expect(options.id).toBe('delivery:unapproved:fpv');
  });

  it('says nothing, and tells the refusal in the row, when the server refuses', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/fpv/unapprove`, () =>
        HttpResponse.json(
          { error: 'Cannot unapprove a video that was delivered. Mark it not delivered first.' },
          { status: 409 },
        ),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([approved])),
    );

    actionsFor(approved).run({ kind: 'unapprove', label: 'Unapprove' });

    await vi.waitFor(() =>
      expect(queryClient.getMutationCache().getAll().at(-1)?.state.status).toBe('error'),
    );
    expect(sonner.toast).not.toHaveBeenCalled();
  });
});
