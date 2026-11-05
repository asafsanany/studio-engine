import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { toast } from 'sonner';
import {
  useDeleteGraphic,
  useDuplicateGraphic,
  useRestoreGraphicVersion,
  useRetryGraphicMessage,
  useRevealGraphic,
  useStopGraphicMessage,
  useUpdateGraphic,
} from '@/data';
import { createStudioActions, type StudioActions } from './studio-actions';

/** The buttons of graphic `id`'s page, wired to the graphics hooks, with the delete request's state. */
export function useStudioActions(id: string): StudioActions & { deleting: boolean } {
  const navigate = useNavigate();
  const stop = useStopGraphicMessage();
  const retry = useRetryGraphicMessage();
  const restore = useRestoreGraphicVersion();
  const update = useUpdateGraphic();
  const duplicate = useDuplicateGraphic();
  const reveal = useRevealGraphic();
  const remove = useDeleteGraphic();

  const stopAsync = stop.mutateAsync;
  const retryAsync = retry.mutateAsync;
  const restoreAsync = restore.mutateAsync;
  const updateAsync = update.mutateAsync;
  const duplicateAsync = duplicate.mutateAsync;
  const revealAsync = reveal.mutateAsync;
  const removeAsync = remove.mutateAsync;

  const actions = useMemo(
    () =>
      createStudioActions({
        id,
        api: {
          stop: stopAsync,
          retry: retryAsync,
          restore: restoreAsync,
          update: updateAsync,
          duplicate: duplicateAsync,
          reveal: revealAsync,
          remove: removeAsync,
        },
        notify: {
          error: (message) => toast.error(message),
          info: (title, detail) => toast(title, { description: detail }),
        },
        openGraphic: (copyId) => void navigate({ to: '/graphics/$id', params: { id: copyId } }),
        goToList: () => navigate({ to: '/graphics' }),
      }),
    [
      id,
      navigate,
      stopAsync,
      retryAsync,
      restoreAsync,
      updateAsync,
      duplicateAsync,
      revealAsync,
      removeAsync,
    ],
  );
  return { ...actions, deleting: remove.isPending };
}
