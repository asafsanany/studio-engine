import { JOB_REVEAL_MESSAGES } from '@studio/shared';
import { MutationObserver } from '@tanstack/react-query';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import {
  REVEAL_JOB_MUTATION_KEY,
  REVEAL_JOB_TOAST_ID,
  revealJobMutationOptions,
} from './reveal-job';
import { BASE_URL, createTestQueryClient } from './test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = createApi({ baseUrl: BASE_URL });
const JOB = 'a1b2c3d4e5f6';

function mutation(error = vi.fn()) {
  const queryClient = createTestQueryClient();
  const observer = new MutationObserver(
    queryClient,
    revealJobMutationOptions({ api, notify: { error } }),
  );
  return { observer, error };
}

describe('revealJobMutationOptions', () => {
  it('shows the job in Finder and says nothing when it worked', async () => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB}/reveal`, () =>
        HttpResponse.json({ ok: true, revealed: 'file' }),
      ),
    );
    const { observer, error } = mutation();

    await expect(observer.mutate(JOB)).resolves.toEqual({ ok: true, revealed: 'file' });

    expect(error).not.toHaveBeenCalled();
    expect(revealJobMutationOptions({ api, notify: { error } }).mutationKey).toEqual([
      REVEAL_JOB_MUTATION_KEY,
    ]);
  });

  it.each([
    [404, JOB_REVEAL_MESSAGES.folderMissing],
    [404, `Job ${JOB} not found`],
    [500, JOB_REVEAL_MESSAGES.couldNotOpen],
  ])('toasts the server’s words for a %s: %s', async (status, message) => {
    server.use(
      http.post(`${BASE_URL}/api/jobs/${JOB}/reveal`, () =>
        HttpResponse.json({ error: message }, { status }),
      ),
    );
    const { observer, error } = mutation();

    await expect(observer.mutate(JOB)).rejects.toMatchObject({ status, message });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Couldn't show it in Finder", {
      id: REVEAL_JOB_TOAST_ID,
      description: message,
    });
  });

  it('toasts when the engine cannot be reached, without a description of its own to add', async () => {
    server.use(http.post(`${BASE_URL}/api/jobs/${JOB}/reveal`, () => HttpResponse.error()));
    const { observer, error } = mutation();

    await expect(observer.mutate(JOB)).rejects.toMatchObject({ status: 0 });

    expect(error).toHaveBeenCalledWith("Couldn't show it in Finder", {
      id: REVEAL_JOB_TOAST_ID,
      description: 'Cannot reach the Studio Engine server.',
    });
  });
});
