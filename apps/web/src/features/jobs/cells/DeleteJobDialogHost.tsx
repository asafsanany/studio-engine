import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import type { StoreApi } from 'zustand';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { api } from '@/data';
import { JOBS_KEY } from '@/data/jobs-cache';
import { type DeleteDialogState, deleteDialogStore, useDeleteDialog } from '../delete-job-dialog';

/** What the dialog says, depending on whether the job has money attached. */
function warning(delivered: boolean): string {
  const base = 'Its folder, its export and everything the app knows about it are deleted for good.';
  return delivered ? `${base} Its payment is removed from Money too.` : base;
}

/**
 * "Delete this video?" for the whole Jobs page. Deleting removes the job's folder, export and every
 * record about it, the delivery and payment included, so the dialog names what goes and cannot be
 * undone. Mount it once, on the page.
 */
export function DeleteJobDialogHost({
  store = deleteDialogStore,
}: {
  store?: StoreApi<DeleteDialogState>;
}) {
  const { job, pending, error, setPending, fail, dismiss } = useDeleteDialog(store);
  const queryClient = useQueryClient();
  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().dismiss(), [store]);

  async function confirm() {
    if (job === null) return;
    setPending(true);
    try {
      await api.deleteJob(job.id);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    dismiss();
    void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
    toast.success(`Deleted “${job.name}”`, { description: job.client });
  }

  return (
    <AlertDialog
      open={job !== null}
      onOpenChange={(open) => {
        if (!open && !pending) dismiss();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.43]">
            {error === null ? `Delete “${job?.name ?? ''}”?` : "Couldn't delete this video"}
          </AlertDialogTitle>
          <AlertDialogDescription>{error ?? warning(job?.delivery != null)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {error === null ? 'Keep it' : 'OK'}
          </AlertDialogCancel>
          {error === null && (
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              aria-busy={pending}
              onClick={(event) => {
                // Radix would close the dialog now; it closes when the answer is in.
                event.preventDefault();
                void confirm();
              }}
            >
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {pending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
