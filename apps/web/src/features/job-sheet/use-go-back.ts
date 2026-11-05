import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, useRestoreJobVersion } from '@/data';
import { cutName } from './sheet-versions';

/**
 * "Go back to this version…" for one job, shared by the sheet's Versions part and the preview
 * viewer: `ask(n)` opens the confirm dialog (`<GoBackDialog target={asking} …>`), `confirm` sends
 * the restore and tells the result in a toast ("Back on Cut 2" or the server's reason). The dialog
 * closes when the answer is in; `onRestored` runs after a restore that worked.
 */
export function useGoBack(jobId: string, onRestored?: () => void) {
  const [asking, setAsking] = useState<number | null>(null);
  const restore = useRestoreJobVersion();
  const confirm = () => {
    if (asking === null) return;
    const n = asking;
    restore.mutate(
      { id: jobId, n },
      {
        onSuccess: () => {
          setAsking(null);
          toast.success(`Back on ${cutName(n)}`);
          onRestored?.();
        },
        onError: (error) => {
          setAsking(null);
          toast.error(`Couldn’t go back to ${cutName(n)}`, {
            description: error instanceof ApiError ? error.message : undefined,
          });
        },
      },
    );
  };
  return { asking, ask: setAsking, pending: restore.isPending, confirm };
}
