// Use this look (Phase 2 plan §8) and its Undo: the two calls that replace a client's style.
//
// No optimistic update: the server decides (409 unless the job is ready or while the client is
// analysing), so the cache takes the style it answers with, which is `analysing` while the Learn
// pass runs. `applyClientStyle` writes it over the cached one and loads the query again; the
// `client.upsert` events then keep it right until the pass ends (job-events.ts).

import type { ClientStyle } from '@studio/shared';
import { mutationOptions, type QueryClient } from '@tanstack/react-query';
import type { Api, ApiError } from './api';
import { applyClientStyle } from './client-style';

/** First element of the Use this look mutation's key. */
export const APPLY_LOOK_MUTATION_KEY = 'apply-look';

/** First element of the Undo mutation's key. */
export const UNDO_CLIENT_STYLE_MUTATION_KEY = 'undo-client-style';

export interface LookMutationParams {
  queryClient: QueryClient;
  api: Api;
}

/** The mutation of Use this look: the variable is the job id, the result the client's new style. */
export function applyLookMutationOptions({ queryClient, api }: LookMutationParams) {
  return mutationOptions<ClientStyle, ApiError, string>({
    mutationKey: [APPLY_LOOK_MUTATION_KEY],
    mutationFn: (jobId) => api.applyLook(jobId),
    onSuccess: (style) => applyClientStyle(queryClient, style),
  });
}

/** The mutation of Undo: the variable is the client id, the result the client's restored style. */
export function undoClientStyleMutationOptions({ queryClient, api }: LookMutationParams) {
  return mutationOptions<ClientStyle, ApiError, string>({
    mutationKey: [UNDO_CLIENT_STYLE_MUTATION_KEY],
    mutationFn: (clientId) => api.undoClientStyle(clientId),
    onSuccess: (style) => applyClientStyle(queryClient, style),
  });
}
