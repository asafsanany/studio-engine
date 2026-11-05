// What a row does for Approve, which only its right-click menu offers (the owner, 31 Oct): the request
// goes to the server, and a message says the final video is rendering once the server has answered.
// The routes are answered by MSW; the messages are sonner's, mocked. There is no DOM, so the hook is
// rendered once to take its actions.

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

const inReview: Job = makeJob({
  id: 'croissant',
  name: 'קרואסון',
  state: 'review',
  step: 7,
  placeInLine: null,
  runKind: 'edit',
  preview: { durationSec: 20.9, width: 1080, height: 1920 },
});
const rendering: Job = {
  ...inReview,
  state: 'editing',
  step: 8,
  runKind: 'render',
  approvedAt: '2026-10-31T09:00:00.000Z',
};

let queryClient: QueryClient;
beforeEach(() => {
  sonner.toast.mockClear();
  sonner.toast.error.mockClear();
  queryClient = createTestQueryClient();
  queryClient.setQueryData(JOBS_KEY, [inReview]);
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

describe('useRowActions: Approve', () => {
  it('posts to the approve route, then says the final video is rendering', async () => {
    const posted: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/jobs/croissant/approve`, ({ request }) => {
        posted.push(new URL(request.url).pathname);
        return HttpResponse.json(rendering);
      }),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([rendering])),
    );

    actionsFor(inReview).run({ kind: 'approve', label: 'Approve' });

    await vi.waitFor(() => expect(sonner.toast).toHaveBeenCalledOnce());
    expect(posted).toEqual(['/api/jobs/croissant/approve']);
    const [message, options] = sonner.toast.mock.calls[0] as [unknown, { id: string }];
    const text = renderToStaticMarkup(message as React.ReactElement);
    expect(text).toContain('Approved “<bdi>קרואסון</bdi>” · the final video is rendering');
    expect(options.id).toBe('delivery:approved:croissant');
  });

  it('says nothing, and tells the refusal in the row, when the server refuses', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/croissant/approve`, () =>
        HttpResponse.json({ error: 'Send or delete your notes first.' }, { status: 409 }),
      ),
      http.get(`${BASE_URL}/api/jobs`, () => HttpResponse.json([inReview])),
    );

    actionsFor(inReview).run({ kind: 'approve', label: 'Approve' });

    await vi.waitFor(() =>
      expect(queryClient.getMutationCache().getAll().at(-1)?.state.status).toBe('error'),
    );
    expect(sonner.toast).not.toHaveBeenCalled();
  });
});
