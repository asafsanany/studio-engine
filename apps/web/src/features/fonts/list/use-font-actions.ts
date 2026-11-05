import { useMemo } from 'react';
import { toast } from 'sonner';
import { useDeleteFont, useRevealFont } from '@/data';
import { createFontActions, type FontActions, type FontNotice } from './font-actions';

/** How long a refusal or a note stays on screen if nobody dismisses it. */
const NOTICE_MS = 8000;

/** The list says things as toasts, like the rest of the app. */
const toastNotice: FontNotice = {
  error: (message) => {
    toast.error(message, { duration: NOTICE_MS });
  },
  info: (title, detail) => {
    toast(title, { description: detail, duration: detail === undefined ? 3000 : NOTICE_MS });
  },
};

/** The actions of the Fonts list's rows over FN1's mutations (the caches follow the engine's answers and events). */
export function useFontActions(): FontActions {
  const { mutateAsync: reveal } = useRevealFont();
  const { mutateAsync: remove } = useDeleteFont();

  return useMemo(
    () =>
      createFontActions({
        reveal,
        remove,
        copyText: (text) => navigator.clipboard.writeText(text),
        notice: toastNotice,
      }),
    [reveal, remove],
  );
}
