import type { GraphicDetail, GraphicSummary } from '@studio/shared';
import {
  MutationObserver,
  type MutationObserverOptions,
  type QueryClient,
} from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  createGraphicMutationOptions,
  deleteGraphicMutationOptions,
  duplicateGraphicMutationOptions,
  GRAPHIC_MUTATION_KEYS,
  type GraphicMutationParams,
  graphicVoiceMutationOptions,
  restoreGraphicVersionMutationOptions,
  retryGraphicMessageMutationOptions,
  revealGraphicMutationOptions,
  sendGraphicMessageMutationOptions,
  stopGraphicMessageMutationOptions,
  updateGraphicMutationOptions,
} from './graphic-mutations';
import type { GraphicsApi } from './graphics-api';
import { GRAPHIC_LIST_KEY, graphicKey } from './graphics-query';
import { ME_KEY } from './me-query';
import {
  createTestQueryClient,
  GRAPHIC_ID,
  makeGraphicDetail,
  makeGraphicSummary,
} from './test-utils';

function fakeApi(answer: GraphicDetail): GraphicsApi {
  return {
    listGraphics: vi.fn(async () => [makeGraphicSummary()]),
    getGraphic: vi.fn(async () => answer),
    createGraphic: vi.fn(async () => answer),
    sendMessage: vi.fn(async () => answer),
    stopMessage: vi.fn(async () => answer),
    retryMessage: vi.fn(async () => answer),
    restoreVersion: vi.fn(async () => answer),
    updateGraphic: vi.fn(async () => answer),
    duplicateGraphic: vi.fn(async () => answer),
    revealGraphic: vi.fn(async () => {}),
    deleteGraphic: vi.fn(async () => ({ ok: true as const, where: '/Trash/x' })),
    transcribeVoice: vi.fn(async () => 'Make it slower.'),
  };
}

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

/** Runs one mutation, whatever its types, as a component's `mutateAsync` would. */
function run<TData, TVariables>(
  options: MutationObserverOptions<TData, ApiError, TVariables>,
  variables: TVariables,
): Promise<TData> {
  return new MutationObserver(queryClient, options).mutate(variables);
}

describe('the graphics actions', () => {
  it('put the graphic every action answers on its page and in the list', async () => {
    const other = makeGraphicSummary({ id: '000000000002', updatedAt: '2026-10-22T08:00:00.000Z' });
    const send = { text: 'x', effort: null, files: [] };

    /** Runs one action over a list holding `other`; its answer must be the page and in the list. */
    async function check<TVariables>(
      make: (
        params: GraphicMutationParams,
      ) => MutationObserverOptions<GraphicDetail, ApiError, TVariables>,
      variables: TVariables,
    ) {
      queryClient.clear();
      queryClient.setQueryData<GraphicSummary[]>(GRAPHIC_LIST_KEY, [other]);
      const answer = makeGraphicDetail({ name: `After ${make.name}` });
      await run(make({ queryClient, api: fakeApi(answer) }), variables);
      expect(queryClient.getQueryData(graphicKey(GRAPHIC_ID)), make.name).toEqual(answer);
      expect(
        queryClient.getQueryData<GraphicSummary[]>(GRAPHIC_LIST_KEY)?.map((g) => g.name),
        make.name,
      ).toEqual([`After ${make.name}`, other.name]);
    }

    await check(createGraphicMutationOptions, send);
    await check(sendGraphicMessageMutationOptions, { id: GRAPHIC_ID, send });
    await check(stopGraphicMessageMutationOptions, { id: GRAPHIC_ID, messageId: 'm' });
    await check(retryGraphicMessageMutationOptions, { id: GRAPHIC_ID, messageId: 'm' });
    await check(restoreGraphicVersionMutationOptions, { id: GRAPHIC_ID, version: 1 });
    await check(updateGraphicMutationOptions, { id: GRAPHIC_ID, patch: { uses: false } });
    await check(duplicateGraphicMutationOptions, GRAPHIC_ID);
  });

  it('pass the variables to the API', async () => {
    const api = fakeApi(makeGraphicDetail());
    await run(sendGraphicMessageMutationOptions({ queryClient, api }), {
      id: GRAPHIC_ID,
      send: { text: 'Slower.', effort: 'high', files: [] },
    });
    await run(updateGraphicMutationOptions({ queryClient, api }), {
      id: GRAPHIC_ID,
      patch: { name: 'Pill' },
    });
    expect(api.sendMessage).toHaveBeenCalledWith(GRAPHIC_ID, {
      text: 'Slower.',
      effort: 'high',
      files: [],
    });
    expect(api.updateGraphic).toHaveBeenCalledWith(GRAPHIC_ID, { name: 'Pill' });
  });

  it('take a deleted graphic out of the list and its page', async () => {
    queryClient.setQueryData<GraphicSummary[]>(GRAPHIC_LIST_KEY, [makeGraphicSummary()]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    const answer = await run(
      deleteGraphicMutationOptions({ queryClient, api: fakeApi(makeGraphicDetail()) }),
      GRAPHIC_ID,
    );
    expect(answer).toEqual({ ok: true, where: '/Trash/x' });
    expect(queryClient.getQueryData(GRAPHIC_LIST_KEY)).toEqual([]);
    expect(queryClient.getQueryData(graphicKey(GRAPHIC_ID))).toBeUndefined();
  });

  it('change no cache for Show in Finder or a voice note, and answer the text', async () => {
    const api = fakeApi(makeGraphicDetail());
    await run(revealGraphicMutationOptions({ api }), GRAPHIC_ID);
    expect(api.revealGraphic).toHaveBeenCalledWith(GRAPHIC_ID);
    expect(await run(graphicVoiceMutationOptions({ api }), new Blob(['x']))).toBe(
      'Make it slower.',
    );
    // Only who is asking (the test client's own `['me']`) is in the cache.
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([ME_KEY]);
  });

  it('leave the caches as they were when the server refuses', async () => {
    const before = makeGraphicDetail();
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), before);
    const api = fakeApi(before);
    api.updateGraphic = vi.fn(async () => {
      throw new ApiError(422, 'Another graphic already has this name.');
    });
    await expect(
      run(updateGraphicMutationOptions({ queryClient, api }), {
        id: GRAPHIC_ID,
        patch: { name: 'Title' },
      }),
    ).rejects.toThrow('Another graphic already has this name.');
    expect(queryClient.getQueryData(graphicKey(GRAPHIC_ID))).toEqual(before);
  });

  it('have one key each', () => {
    const keys = Object.values(GRAPHIC_MUTATION_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
