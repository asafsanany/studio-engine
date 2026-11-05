// The graphics actions (Graphics plan, "API"): a new graphic, a message, Stop, Retry, "Use vN
// again", rename / When / Edits can use it, Duplicate, Show in Finder, Delete and the voice note.
//
// No optimistic update: the server decides (409 while a version is being made, 422 for a name),
// so the caches take what it answers. Every action but Show in Finder, Delete and the voice note
// answers the whole graphic, which replaces its page and goes into the list (`applyGraphicDetail`);
// the `graphic.changed` events then keep it right while its run moves on.

import type { DeleteGraphicResponse, GraphicDetail, UpdateGraphicRequest } from '@studio/shared';
import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { ApiError } from './api';
import { type GraphicSend, type GraphicsApi, graphicsApi } from './graphics-api';
import { applyGraphicDetail, removeGraphic } from './graphics-cache';

/** First element of each graphics mutation's key. */
export const GRAPHIC_MUTATION_KEYS = {
  create: 'create-graphic',
  send: 'send-graphic-message',
  stop: 'stop-graphic-message',
  retry: 'retry-graphic-message',
  restore: 'restore-graphic-version',
  update: 'update-graphic',
  duplicate: 'duplicate-graphic',
  reveal: 'reveal-graphic',
  remove: 'delete-graphic',
  voice: 'graphic-voice',
} as const;

export interface GraphicMutationParams {
  queryClient: QueryClient;
  api: GraphicsApi;
}

/** A new graphic from the first message; the result is the graphic, v1 being made. */
export function createGraphicMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<GraphicDetail, ApiError, GraphicSend>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.create],
    mutationFn: (send) => api.createGraphic(send),
    onSuccess: (detail) => applyGraphicDetail(queryClient, detail),
  });
}

/** A message asking for a change: the variables are the graphic and the message. */
export function sendGraphicMessageMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<GraphicDetail, ApiError, { id: string; send: GraphicSend }>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.send],
    mutationFn: ({ id, send }) => api.sendMessage(id, send),
    onSuccess: (detail) => applyGraphicDetail(queryClient, detail),
  });
}

/** Stop of Claude's row `messageId`. */
export function stopGraphicMessageMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<GraphicDetail, ApiError, { id: string; messageId: string }>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.stop],
    mutationFn: ({ id, messageId }) => api.stopMessage(id, messageId),
    onSuccess: (detail) => applyGraphicDetail(queryClient, detail),
  });
}

/** Retry of Claude's failed or stopped row `messageId`. */
export function retryGraphicMessageMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<GraphicDetail, ApiError, { id: string; messageId: string }>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.retry],
    mutationFn: ({ id, messageId }) => api.retryMessage(id, messageId),
    onSuccess: (detail) => applyGraphicDetail(queryClient, detail),
  });
}

/** "Use vN again". */
export function restoreGraphicVersionMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<GraphicDetail, ApiError, { id: string; version: number }>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.restore],
    mutationFn: ({ id, version }) => api.restoreVersion(id, version),
    onSuccess: (detail) => applyGraphicDetail(queryClient, detail),
  });
}

/** Rename, the When line, "Edits can use it". */
export function updateGraphicMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<GraphicDetail, ApiError, { id: string; patch: UpdateGraphicRequest }>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.update],
    mutationFn: ({ id, patch }) => api.updateGraphic(id, patch),
    onSuccess: (detail) => applyGraphicDetail(queryClient, detail),
  });
}

/** Duplicate: the result is the copy. */
export function duplicateGraphicMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<GraphicDetail, ApiError, string>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.duplicate],
    mutationFn: (id) => api.duplicateGraphic(id),
    onSuccess: (detail) => applyGraphicDetail(queryClient, detail),
  });
}

/** Show in Finder. Nothing in the caches changes. */
export function revealGraphicMutationOptions({ api }: Pick<GraphicMutationParams, 'api'>) {
  return mutationOptions<void, ApiError, string>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.reveal],
    mutationFn: (id) => api.revealGraphic(id),
  });
}

/** Delete: the graphic leaves the list and its page; the result says where its folder went. */
export function deleteGraphicMutationOptions({ queryClient, api }: GraphicMutationParams) {
  return mutationOptions<DeleteGraphicResponse, ApiError, string>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.remove],
    mutationFn: (id) => api.deleteGraphic(id),
    onSuccess: (_answer, id) => removeGraphic(queryClient, id),
  });
}

/** The composer's voice note: the result is its text. Nothing in the caches changes. */
export function graphicVoiceMutationOptions({ api }: Pick<GraphicMutationParams, 'api'>) {
  return mutationOptions<string, ApiError, Blob>({
    mutationKey: [GRAPHIC_MUTATION_KEYS.voice],
    mutationFn: (audio) => api.transcribeVoice(audio),
  });
}

/** A new graphic: `mutateAsync(send)` resolves with it (navigate to /graphics/<id>). */
export function useCreateGraphic() {
  const queryClient = useQueryClient();
  return useMutation(createGraphicMutationOptions({ queryClient, api: graphicsApi }));
}

/** A change: `mutateAsync({ id, send })`. */
export function useSendGraphicMessage() {
  const queryClient = useQueryClient();
  return useMutation(sendGraphicMessageMutationOptions({ queryClient, api: graphicsApi }));
}

/** Stop: `mutateAsync({ id, messageId })`. */
export function useStopGraphicMessage() {
  const queryClient = useQueryClient();
  return useMutation(stopGraphicMessageMutationOptions({ queryClient, api: graphicsApi }));
}

/** Retry: `mutateAsync({ id, messageId })`. */
export function useRetryGraphicMessage() {
  const queryClient = useQueryClient();
  return useMutation(retryGraphicMessageMutationOptions({ queryClient, api: graphicsApi }));
}

/** "Use vN again": `mutateAsync({ id, version })`. */
export function useRestoreGraphicVersion() {
  const queryClient = useQueryClient();
  return useMutation(restoreGraphicVersionMutationOptions({ queryClient, api: graphicsApi }));
}

/** Rename, When, Edits can use it: `mutateAsync({ id, patch })`. */
export function useUpdateGraphic() {
  const queryClient = useQueryClient();
  return useMutation(updateGraphicMutationOptions({ queryClient, api: graphicsApi }));
}

/** Duplicate: `mutateAsync(id)` resolves with the copy. */
export function useDuplicateGraphic() {
  const queryClient = useQueryClient();
  return useMutation(duplicateGraphicMutationOptions({ queryClient, api: graphicsApi }));
}

/** Show in Finder: `mutateAsync(id)`. */
export function useRevealGraphic() {
  return useMutation(revealGraphicMutationOptions({ api: graphicsApi }));
}

/** Delete: `mutateAsync(id)`. */
export function useDeleteGraphic() {
  const queryClient = useQueryClient();
  return useMutation(deleteGraphicMutationOptions({ queryClient, api: graphicsApi }));
}

/** The composer's mic: `mutateAsync(audio)` resolves with the text. */
export function useGraphicVoice() {
  return useMutation(graphicVoiceMutationOptions({ api: graphicsApi }));
}
