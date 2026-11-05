import type { LutDetail, LutListResponse } from '@studio/shared';
import {
  MutationObserver,
  type MutationObserverOptions,
  type QueryClient,
} from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  cancelLutStageMutationOptions,
  deleteLutMutationOptions,
  duplicateLutMutationOptions,
  importLutsMutationOptions,
  LUT_MUTATION_KEYS,
  revealLutMutationOptions,
  stageLutsMutationOptions,
  updateLutMutationOptions,
} from './lut-mutations';
import type { LutsApi } from './luts-api';
import { LUT_LIST_KEY, lutKey } from './luts-query';
import { ME_KEY } from './me-query';
import { createTestQueryClient, makeLutDetail, makeLutSummary } from './test-utils';

function fakeApi(answer: LutDetail): LutsApi {
  return {
    listLuts: vi.fn(async () => ({ yours: [], builtIn: [], builtInAvailable: false })),
    getLut: vi.fn(async () => answer),
    updateLut: vi.fn(async () => answer),
    deleteLut: vi.fn(async () => ({ ok: true as const, where: '/Trash/x' })),
    duplicateLut: vi.fn(async () => answer),
    revealLut: vi.fn(async () => {}),
    stageLuts: vi.fn(async () => ({ stageId: 's1', files: [] })),
    cancelStage: vi.fn(async () => {}),
    importStaged: vi.fn(async () => ({
      imported: [makeLutSummary({ slug: 'new-one' })],
      failed: [],
    })),
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

const list = () => queryClient.getQueryData<LutListResponse>(LUT_LIST_KEY);

describe('the LUTs actions', () => {
  it('key each action', () => {
    expect(Object.values(LUT_MUTATION_KEYS)).toHaveLength(7);
    expect(stageLutsMutationOptions({ api: fakeApi(makeLutDetail()) }).mutationKey).toEqual([
      LUT_MUTATION_KEYS.stage,
    ]);
  });

  it('put the LUT Rename and Duplicate answer on its pane and in the list', async () => {
    queryClient.setQueryData<LutListResponse>(LUT_LIST_KEY, {
      yours: [makeLutSummary({ slug: 'other', addedAt: '2026-10-20T10:00:00.000Z' })],
      builtIn: [],
      builtInAvailable: true,
    });
    const answer = makeLutDetail({
      slug: 'copy',
      name: 'Copy',
      addedAt: '2026-10-24T10:00:00.000Z',
    });

    await run(
      duplicateLutMutationOptions({ queryClient, api: fakeApi(answer) }),
      'golden-hour-warm',
    );

    expect(queryClient.getQueryData(lutKey('copy'))).toEqual(answer);
    expect(list()?.yours.map((l) => l.slug)).toEqual(['copy', 'other']);
  });

  it('move a renamed LUT to its new slug', async () => {
    const before = makeLutSummary();
    queryClient.setQueryData<LutListResponse>(LUT_LIST_KEY, {
      yours: [before],
      builtIn: [],
      builtInAvailable: true,
    });
    queryClient.setQueryData(lutKey('golden-hour-warm'), makeLutDetail());
    const answer = makeLutDetail({ slug: 'sunset-amber', name: 'Sunset Amber' });
    const api = fakeApi(answer);

    await run(updateLutMutationOptions({ queryClient, api }), {
      slug: 'golden-hour-warm',
      patch: { name: 'Sunset Amber' },
    });

    expect(api.updateLut).toHaveBeenCalledWith('golden-hour-warm', { name: 'Sunset Amber' });
    expect(list()?.yours.map((l) => l.slug)).toEqual(['sunset-amber']);
    expect(queryClient.getQueryData(lutKey('golden-hour-warm'))).toBeUndefined();
    expect(queryClient.getQueryData(lutKey('sunset-amber'))).toEqual(answer);
  });

  it('add the rows an import answers, and say which files failed', async () => {
    queryClient.setQueryData<LutListResponse>(LUT_LIST_KEY, {
      yours: [],
      builtIn: [],
      builtInAvailable: true,
    });
    const api = fakeApi(makeLutDetail());
    const request = { stageId: 's1', items: [{ id: 'f1', kind: 'look' as const }] };

    const answer = await run(importLutsMutationOptions({ queryClient, api }), request);

    expect(api.importStaged).toHaveBeenCalledWith(request);
    expect(answer.failed).toEqual([]);
    expect(list()?.yours.map((l) => l.slug)).toEqual(['new-one']);
  });

  it('take a deleted LUT out of the list and its pane', async () => {
    queryClient.setQueryData<LutListResponse>(LUT_LIST_KEY, {
      yours: [makeLutSummary()],
      builtIn: [],
      builtInAvailable: true,
    });
    queryClient.setQueryData(lutKey('golden-hour-warm'), makeLutDetail());

    const answer = await run(
      deleteLutMutationOptions({ queryClient, api: fakeApi(makeLutDetail()) }),
      'golden-hour-warm',
    );

    expect(answer).toEqual({ ok: true, where: '/Trash/x' });
    expect(list()?.yours).toEqual([]);
    expect(queryClient.getQueryData(lutKey('golden-hour-warm'))).toBeUndefined();
  });

  it('change no cache for the stage, Cancel or Show in Finder', async () => {
    const api = fakeApi(makeLutDetail());
    const staged = await run(stageLutsMutationOptions({ api }), { files: [] });
    await run(cancelLutStageMutationOptions({ api }), 's1');
    await run(revealLutMutationOptions({ api }), 'golden-hour-warm');
    expect(staged).toEqual({ stageId: 's1', files: [] });
    expect(api.cancelStage).toHaveBeenCalledWith('s1');
    expect(api.revealLut).toHaveBeenCalledWith('golden-hour-warm');
    // Only who is asking (the test client's own `['me']`) is in the cache.
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([ME_KEY]);
  });

  it('leave the caches as they were when the server refuses', async () => {
    const before = makeLutDetail();
    queryClient.setQueryData(lutKey('golden-hour-warm'), before);
    const api = fakeApi(before);
    api.updateLut = vi.fn(async () => {
      throw new ApiError(422, 'Another LUT already has this name.');
    });

    await expect(
      run(updateLutMutationOptions({ queryClient, api }), {
        slug: 'golden-hour-warm',
        patch: { name: 'Film contrast' },
      }),
    ).rejects.toThrow('Another LUT already has this name.');

    expect(queryClient.getQueryData(lutKey('golden-hour-warm'))).toEqual(before);
  });
});
