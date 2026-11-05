// The LUTs actions (LUTs plan, "API"): the three steps of an import (stage, cancel, import), rename
// and kind, Delete, Duplicate and Show in Finder.
//
// No optimistic update: the server decides (422 for a name that is taken, 403 for a built-in LUT),
// so the caches take what it answers. Rename / kind and Duplicate answer the whole LUT, which
// replaces its pane and goes into the list (`applyLutDetail`); an import answers the rows it added
// (`applyLutsImported`); the `lut.changed` events then keep them right.

import type {
  DeleteLutResponse,
  LutDetail,
  LutImportRequest,
  LutImportResponse,
  LutStageResponse,
  UpdateLutRequest,
} from '@studio/shared';
import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { ApiError } from './api';
import { type LutStageSend, type LutsApi, lutsApi } from './luts-api';
import { applyLutDetail, applyLutsImported, removeLut } from './luts-cache';

/** First element of each LUTs mutation's key. */
export const LUT_MUTATION_KEYS = {
  stage: 'stage-luts',
  cancelStage: 'cancel-lut-stage',
  importStaged: 'import-luts',
  update: 'update-lut',
  remove: 'delete-lut',
  duplicate: 'duplicate-lut',
  reveal: 'reveal-lut',
} as const;

export interface LutMutationParams {
  queryClient: QueryClient;
  api: LutsApi;
}

/** Import step 1: the files go up and come back with a verdict each. Nothing in the caches changes. */
export function stageLutsMutationOptions({ api }: Pick<LutMutationParams, 'api'>) {
  return mutationOptions<LutStageResponse, ApiError, LutStageSend>({
    mutationKey: [LUT_MUTATION_KEYS.stage],
    mutationFn: (send) => api.stageLuts(send),
  });
}

/** Throws an upload away (Cancel in the dialog). Nothing in the caches changes. */
export function cancelLutStageMutationOptions({ api }: Pick<LutMutationParams, 'api'>) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [LUT_MUTATION_KEYS.cancelStage],
    mutationFn: (stageId) => api.cancelStage(stageId),
  });
}

/** Import step 3: the new rows go into Yours; the result also says which files failed and why. */
export function importLutsMutationOptions({ queryClient, api }: LutMutationParams) {
  return mutationOptions<LutImportResponse, ApiError, LutImportRequest>({
    mutationKey: [LUT_MUTATION_KEYS.importStaged],
    mutationFn: (request) => api.importStaged(request),
    onSuccess: (answer) => applyLutsImported(queryClient, answer.imported),
  });
}

/** Rename and/or kind: the variables are the LUT's slug now and the change. A rename moves the slug. */
export function updateLutMutationOptions({ queryClient, api }: LutMutationParams) {
  return mutationOptions<LutDetail, ApiError, { slug: string; patch: UpdateLutRequest }>({
    mutationKey: [LUT_MUTATION_KEYS.update],
    mutationFn: ({ slug, patch }) => api.updateLut(slug, patch),
    onSuccess: (detail, { slug }) => applyLutDetail(queryClient, detail, slug),
  });
}

/** Delete: the LUT leaves Yours and its pane; the result says where its file went. */
export function deleteLutMutationOptions({ queryClient, api }: LutMutationParams) {
  return mutationOptions<DeleteLutResponse, ApiError, string>({
    mutationKey: [LUT_MUTATION_KEYS.remove],
    mutationFn: (slug) => api.deleteLut(slug),
    onSuccess: (_answer, slug) => removeLut(queryClient, slug),
  });
}

/** Duplicate: the result is the copy, which joins Yours. */
export function duplicateLutMutationOptions({ queryClient, api }: LutMutationParams) {
  return mutationOptions<LutDetail, ApiError, string>({
    mutationKey: [LUT_MUTATION_KEYS.duplicate],
    mutationFn: (slug) => api.duplicateLut(slug),
    onSuccess: (detail) => applyLutDetail(queryClient, detail),
  });
}

/** Show in Finder. Nothing in the caches changes. */
export function revealLutMutationOptions({ api }: Pick<LutMutationParams, 'api'>) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [LUT_MUTATION_KEYS.reveal],
    mutationFn: (slug) => api.revealLut(slug),
  });
}

/** Import step 1: `mutateAsync({ files, onProgress, signal })` resolves with a verdict per file. */
export function useStageLuts() {
  return useMutation(stageLutsMutationOptions({ api: lutsApi }));
}

/** Cancel in the dialog: `mutateAsync(stageId)`. */
export function useCancelLutStage() {
  return useMutation(cancelLutStageMutationOptions({ api: lutsApi }));
}

/** Import step 3: `mutateAsync({ stageId, items })` resolves with the new rows and the failures. */
export function useImportLuts() {
  const queryClient = useQueryClient();
  return useMutation(importLutsMutationOptions({ queryClient, api: lutsApi }));
}

/** Rename, kind: `mutateAsync({ slug, patch })`. */
export function useUpdateLut() {
  const queryClient = useQueryClient();
  return useMutation(updateLutMutationOptions({ queryClient, api: lutsApi }));
}

/** Delete: `mutateAsync(slug)`. */
export function useDeleteLut() {
  const queryClient = useQueryClient();
  return useMutation(deleteLutMutationOptions({ queryClient, api: lutsApi }));
}

/** Duplicate: `mutateAsync(slug)` resolves with the copy. */
export function useDuplicateLut() {
  const queryClient = useQueryClient();
  return useMutation(duplicateLutMutationOptions({ queryClient, api: lutsApi }));
}

/** Show in Finder: `mutateAsync(slug)`. */
export function useRevealLut() {
  return useMutation(revealLutMutationOptions({ api: lutsApi }));
}
