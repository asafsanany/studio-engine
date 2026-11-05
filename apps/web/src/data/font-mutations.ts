// The Fonts actions (Fonts plan, "API"): the three steps of an import (stage, cancel, import),
// Delete and Show in Finder.
//
// No optimistic update: the server decides (a conflict, a family that is gone), so the caches take
// what it answers. An import answers the families it added (`applyFontsImported`) and a delete the
// slug that is gone (`removeFont`); the `font.changed` / `font.removed` events then keep them
// right.

import type {
  DeleteFontResponse,
  FontImportRequest,
  FontImportResponse,
  FontStageResponse,
} from '@studio/shared';
import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { ApiError } from './api';
import { type FontStageSend, type FontsApi, fontsApi } from './fonts-api';
import { applyFontRequestDismissed, applyFontsImported, removeFont } from './fonts-cache';

/** First element of each Fonts mutation's key. */
export const FONT_MUTATION_KEYS = {
  stage: 'stage-fonts',
  cancelStage: 'cancel-font-stage',
  importStaged: 'import-fonts',
  remove: 'delete-font',
  reveal: 'reveal-font',
  dismissRequest: 'dismiss-font-request',
} as const;

export interface FontMutationParams {
  queryClient: QueryClient;
  api: FontsApi;
}

/** Import step 1: the files go up and come back with a verdict each. Nothing in the caches changes. */
export function stageFontsMutationOptions({ api }: Pick<FontMutationParams, 'api'>) {
  return mutationOptions<FontStageResponse, ApiError, FontStageSend>({
    mutationKey: [FONT_MUTATION_KEYS.stage],
    mutationFn: (send) => api.stageFonts(send),
  });
}

/** Throws an upload away (Cancel in the dialog). Nothing in the caches changes. */
export function cancelFontStageMutationOptions({ api }: Pick<FontMutationParams, 'api'>) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [FONT_MUTATION_KEYS.cancelStage],
    mutationFn: (stageId) => api.cancelStage(stageId),
  });
}

/** Import step 3: the new families go into the list; the result also says which items failed and why. */
export function importFontsMutationOptions({ queryClient, api }: FontMutationParams) {
  return mutationOptions<FontImportResponse, ApiError, FontImportRequest>({
    mutationKey: [FONT_MUTATION_KEYS.importStaged],
    mutationFn: (request) => api.importStaged(request),
    onSuccess: (answer) => applyFontsImported(queryClient, answer.imported),
  });
}

/** Delete: the family leaves the list and its pane; the result says where its files went. */
export function deleteFontMutationOptions({ queryClient, api }: FontMutationParams) {
  return mutationOptions<DeleteFontResponse, ApiError, string>({
    mutationKey: [FONT_MUTATION_KEYS.remove],
    mutationFn: (slug) => api.deleteFont(slug),
    onSuccess: (_answer, slug) => removeFont(queryClient, slug),
  });
}

/**
 * "Not a font" on the bar (C52): the request leaves the open requests, and the bar shows the next.
 * A refusal (the request is gone) leaves the caches alone.
 */
export function dismissFontRequestMutationOptions({ queryClient, api }: FontMutationParams) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [FONT_MUTATION_KEYS.dismissRequest],
    mutationFn: (requestId) => api.dismissRequest(requestId),
    onSuccess: (_answer, requestId) => applyFontRequestDismissed(queryClient, requestId),
  });
}

/** Show in Finder. Nothing in the caches changes. */
export function revealFontMutationOptions({ api }: Pick<FontMutationParams, 'api'>) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [FONT_MUTATION_KEYS.reveal],
    mutationFn: (slug) => api.revealFont(slug),
  });
}

/** Import step 1: `mutateAsync({ files, onProgress, signal })` resolves with a verdict per item. */
export function useStageFonts() {
  return useMutation(stageFontsMutationOptions({ api: fontsApi }));
}

/** Cancel in the dialog: `mutateAsync(stageId)`. */
export function useCancelFontStage() {
  return useMutation(cancelFontStageMutationOptions({ api: fontsApi }));
}

/** Import step 3: `mutateAsync({ stageId, items })` resolves with the new families and the failures. */
export function useImportFonts() {
  const queryClient = useQueryClient();
  return useMutation(importFontsMutationOptions({ queryClient, api: fontsApi }));
}

/** Delete: `mutateAsync(slug)`. */
export function useDeleteFont() {
  const queryClient = useQueryClient();
  return useMutation(deleteFontMutationOptions({ queryClient, api: fontsApi }));
}

/** "Not a font": `mutateAsync(requestId)`. */
export function useDismissFontRequest() {
  const queryClient = useQueryClient();
  return useMutation(dismissFontRequestMutationOptions({ queryClient, api: fontsApi }));
}

/** Show in Finder: `mutateAsync(slug)`. */
export function useRevealFont() {
  return useMutation(revealFontMutationOptions({ api: fontsApi }));
}
