import { useMemo } from 'react';
import { toast } from 'sonner';
import { useDeleteLut, useDuplicateLut, useRevealLut, useUpdateLut } from '@/data';
import { createLutActions, type LutActions, type LutNotice } from './lut-actions';

/** How long a refusal or a note stays on screen if nobody dismisses it. */
const NOTICE_MS = 8000;

/** The list says things as toasts, like the rest of the app. */
const toastNotice: LutNotice = {
  error: (message) => {
    toast.error(message, { duration: NOTICE_MS });
  },
  info: (title, detail) => {
    toast(title, { description: detail, duration: detail === undefined ? 3000 : NOTICE_MS });
  },
};

/** The actions of the LUTs list's rows over LU0's mutations (the caches follow the engine's answers and events). */
export function useLutActions(): LutActions {
  const { mutateAsync: update } = useUpdateLut();
  const { mutateAsync: duplicate } = useDuplicateLut();
  const { mutateAsync: reveal } = useRevealLut();
  const { mutateAsync: remove } = useDeleteLut();

  return useMemo(
    () =>
      createLutActions({
        update,
        duplicate,
        reveal,
        remove,
        copyText: (text) => navigator.clipboard.writeText(text),
        notice: toastNotice,
      }),
    [update, duplicate, reveal, remove],
  );
}
