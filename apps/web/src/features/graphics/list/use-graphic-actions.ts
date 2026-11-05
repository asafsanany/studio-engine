import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { toast } from 'sonner';
import {
  graphicsApi,
  useDeleteGraphic,
  useDuplicateGraphic,
  useRetryGraphicMessage,
  useRevealGraphic,
  useUpdateGraphic,
} from '@/data';
import { graphicQueryOptions } from '@/data/graphics-query';
import { createGraphicActions, type GraphicActions, type GraphicNotice } from './graphic-actions';

/** How long a refusal or a note stays on screen if nobody dismisses it. */
const NOTICE_MS = 8000;

/** The list says things as toasts, like the rest of the app. */
const toastNotice: GraphicNotice = {
  error: (message) => {
    toast.error(message, { duration: NOTICE_MS });
  },
  info: (title, detail) => {
    toast(title, { description: detail, duration: NOTICE_MS });
  },
};

/**
 * The actions of the Graphics list's rows over GR0's mutations (the caches follow the engine's
 * answers and its events): Open goes to the graphic's page, and a Retry reads the graphic fresh to
 * find the failed row it makes again.
 */
export function useGraphicActions(): GraphicActions {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const update = useUpdateGraphic();
  const duplicate = useDuplicateGraphic();
  const reveal = useRevealGraphic();
  const remove = useDeleteGraphic();
  const retry = useRetryGraphicMessage();
  const { mutateAsync: updateAsync } = update;
  const { mutateAsync: duplicateAsync } = duplicate;
  const { mutateAsync: revealAsync } = reveal;
  const { mutateAsync: removeAsync } = remove;
  const { mutateAsync: retryAsync } = retry;

  return useMemo(
    () =>
      createGraphicActions({
        open: (id) => void navigate({ to: '/graphics/$id', params: { id } }),
        update: updateAsync,
        duplicate: duplicateAsync,
        reveal: revealAsync,
        remove: removeAsync,
        retryMessage: retryAsync,
        // Asked again whatever the cache holds: the chat is what says which row failed.
        loadDetail: (id) =>
          queryClient.fetchQuery({ ...graphicQueryOptions(graphicsApi, id), staleTime: 0 }),
        notice: toastNotice,
      }),
    [navigate, queryClient, updateAsync, duplicateAsync, revealAsync, removeAsync, retryAsync],
  );
}
