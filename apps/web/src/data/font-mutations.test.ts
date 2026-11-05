import { FONT_MESSAGES, type FontsListResponse } from '@studio/shared';
import {
  MutationObserver,
  type MutationObserverOptions,
  type QueryClient,
} from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  cancelFontStageMutationOptions,
  deleteFontMutationOptions,
  dismissFontRequestMutationOptions,
  FONT_MUTATION_KEYS,
  importFontsMutationOptions,
  revealFontMutationOptions,
  stageFontsMutationOptions,
} from './font-mutations';
import type { FontsApi } from './fonts-api';
import { FONT_LIST_KEY, fontKey } from './fonts-query';
import { ME_KEY } from './me-query';
import {
  createTestQueryClient,
  makeFontFace,
  makeFontFamilyDetail,
  makeFontFamilySummary,
  makeFontRequest,
  makeFontStageItem,
} from './test-utils';

const karantina = makeFontFamilySummary({ slug: 'karantina', name: 'Karantina', isNew: true });

function fakeApi(): FontsApi {
  return {
    listFonts: vi.fn(async () => ({ families: [], catalog: [], requests: [] })),
    getFont: vi.fn(async () => makeFontFamilyDetail()),
    revealFont: vi.fn(async () => {}),
    deleteFont: vi.fn(async () => ({ ok: true as const, where: '/Trash/x' })),
    dismissRequest: vi.fn(async () => {}),
    stageFonts: vi.fn(async () => ({ stageId: 's1', items: [makeFontStageItem()] })),
    cancelStage: vi.fn(async () => {}),
    importStaged: vi.fn(async () => ({ imported: [karantina], failed: [] })),
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

const list = () => queryClient.getQueryData<FontsListResponse>(FONT_LIST_KEY);

describe('the Fonts actions', () => {
  it('key each action', () => {
    expect(Object.values(FONT_MUTATION_KEYS)).toHaveLength(6);
    expect(stageFontsMutationOptions({ api: fakeApi() }).mutationKey).toEqual([
      FONT_MUTATION_KEYS.stage,
    ]);
  });

  it('add the families an import answers to the list, and say which items failed', async () => {
    queryClient.setQueryData<FontsListResponse>(FONT_LIST_KEY, {
      families: [makeFontFamilySummary()],
      catalog: [makeFontFace()],
      requests: [],
    });
    const api = fakeApi();
    const request = { stageId: 's1', items: ['karantina'] };

    const answer = await run(importFontsMutationOptions({ queryClient, api }), request);

    expect(api.importStaged).toHaveBeenCalledWith(request);
    expect(answer.failed).toEqual([]);
    expect(list()?.families.map((family) => family.slug)).toEqual(['heebo', 'karantina']);
    // Their faces and the open requests come from the server again.
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
  });

  it('take a deleted family out of the list with its faces, and out of its pane', async () => {
    queryClient.setQueryData<FontsListResponse>(FONT_LIST_KEY, {
      families: [makeFontFamilySummary()],
      catalog: [makeFontFace()],
      requests: [],
    });
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());

    const answer = await run(deleteFontMutationOptions({ queryClient, api: fakeApi() }), 'heebo');

    expect(answer).toEqual({ ok: true, where: '/Trash/x' });
    expect(list()).toEqual({ families: [], catalog: [], requests: [] });
    expect(queryClient.getQueryData(fontKey('heebo'))).toBeUndefined();
  });

  it('take a dismissed request out of the list at once and ask for the list again ("Not a font")', async () => {
    const falcon = makeFontRequest({ id: 'a3c19e0b7d44', name: 'Falcon' });
    const gotham = makeFontRequest({ id: 'b4d20f1c8e55', name: 'Gotham Bold' });
    queryClient.setQueryData<FontsListResponse>(FONT_LIST_KEY, {
      families: [makeFontFamilySummary()],
      catalog: [makeFontFace()],
      requests: [falcon, gotham],
    });
    const api = fakeApi();

    await run(dismissFontRequestMutationOptions({ queryClient, api }), 'a3c19e0b7d44');

    expect(api.dismissRequest).toHaveBeenCalledWith('a3c19e0b7d44');
    expect(list()?.requests).toEqual([gotham]);
    expect(list()?.families).toHaveLength(1);
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
  });

  it('leave the requests as they were when the server refuses a dismissal', async () => {
    const falcon = makeFontRequest({ id: 'a3c19e0b7d44', name: 'Falcon' });
    queryClient.setQueryData<FontsListResponse>(FONT_LIST_KEY, {
      families: [],
      catalog: [],
      requests: [falcon],
    });
    const api = fakeApi();
    api.dismissRequest = vi.fn(async () => {
      throw new ApiError(404, FONT_MESSAGES.requestNotFound);
    });

    await expect(
      run(dismissFontRequestMutationOptions({ queryClient, api }), 'a3c19e0b7d44'),
    ).rejects.toThrow(FONT_MESSAGES.requestNotFound);

    expect(list()?.requests).toEqual([falcon]);
  });

  it('change no cache for the stage, Cancel or Show in Finder', async () => {
    const api = fakeApi();
    const staged = await run(stageFontsMutationOptions({ api }), { files: [] });
    await run(cancelFontStageMutationOptions({ api }), 's1');
    await run(revealFontMutationOptions({ api }), 'heebo');
    expect(staged).toEqual({ stageId: 's1', items: [makeFontStageItem()] });
    expect(api.cancelStage).toHaveBeenCalledWith('s1');
    expect(api.revealFont).toHaveBeenCalledWith('heebo');
    // Only who is asking (the test client's own `['me']`) is in the cache.
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([ME_KEY]);
  });

  it('leave the caches as they were when the server refuses', async () => {
    const before = makeFontFamilyDetail();
    queryClient.setQueryData(fontKey('heebo'), before);
    queryClient.setQueryData<FontsListResponse>(FONT_LIST_KEY, {
      families: [makeFontFamilySummary()],
      catalog: [],
      requests: [],
    });
    const api = fakeApi();
    api.deleteFont = vi.fn(async () => {
      throw new ApiError(500, FONT_MESSAGES.deleteFailed);
    });

    await expect(run(deleteFontMutationOptions({ queryClient, api }), 'heebo')).rejects.toThrow(
      FONT_MESSAGES.deleteFailed,
    );

    expect(queryClient.getQueryData(fontKey('heebo'))).toEqual(before);
    expect(list()?.families).toHaveLength(1);
  });
});
