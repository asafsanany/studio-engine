import type { Job } from '@studio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
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
import { Input } from '@/components/ui/input';
import { api } from '@/data';
import { JOBS_KEY, removeJob, upsertJob } from '@/data/jobs-cache';
import { useOpenJobSheetId } from '@/features/job-sheet/job-sheet-open';
import { moveJobSheet } from '@/features/job-sheet/job-sheet-search';
import { bidiProps } from '@/lib/bidi';
import {
  confirmRename,
  type RenameDialogState,
  renameDialogStore,
  renameReadiness,
  useRenameDialog,
} from '../rename-job-dialog';

/** The words of the dialog. */
export const RENAME_DIALOG_TEXT = {
  title: 'Rename this video',
  description: 'Its folder and its exported file get the new name too.',
  label: 'Name',
  cancel: 'Cancel',
  confirm: 'Rename',
  confirming: 'Renaming…',
} as const;

const NAME_INPUT_ID = 'rename-job-name';
const PROBLEM_ID = 'rename-job-problem';

/**
 * "Rename this video" for the whole Jobs page. The name is the folder's, so the dialog says the
 * folder and the export follow; Rename waits for the server (which moves them) and is off while the
 * name is empty, unchanged or not one a folder can have. A name the server refuses is explained under
 * the input. A renamed job has a new id: the list is told at once (the new row comes, the old one
 * goes) and an open sheet follows it. Mount it once, on the page.
 */
export function RenameJobDialogHost({
  store = renameDialogStore,
}: {
  store?: StoreApi<RenameDialogState>;
}) {
  const { job, name, pending, error, setName } = useRenameDialog(store);
  const queryClient = useQueryClient();
  const router = useRouter({ warn: false });
  const sheetJobId = useOpenJobSheetId();
  const input = useRef<HTMLInputElement>(null);
  // Leaving the page closes the dialog; the shared store must not bring it back on the next visit.
  useEffect(() => () => store.getState().dismiss(), [store]);
  // A refused name sends the cursor back to the input (it was locked while the request ran).
  useEffect(() => {
    if (error === null || pending) return;
    input.current?.focus();
    input.current?.select();
  }, [error, pending]);

  const readiness = renameReadiness(job, name);
  const problem = error ?? readiness.problem;

  const confirm = () =>
    void confirmRename(
      {
        rename: (id, newName) => api.renameJob(id, newName),
        async onRenamed(before, renamed) {
          // The new row comes first, so a sheet open on the job has something to move to; the old
          // one (the server's `job.remove` may have taken it already) goes after.
          queryClient.setQueryData<readonly Job[]>(JOBS_KEY, (list) =>
            list === undefined ? list : upsertJob(list, renamed),
          );
          if (router && sheetJobId === before.id) await moveJobSheet(router, renamed.id);
          queryClient.setQueryData<readonly Job[]>(JOBS_KEY, (list) =>
            list === undefined ? list : removeJob(list, before.id),
          );
          void queryClient.invalidateQueries({ queryKey: JOBS_KEY });
        },
        notify: (message, description) => toast.success(message, { description }),
      },
      store,
    );

  return (
    <AlertDialog
      open={job !== null}
      onOpenChange={(open) => {
        if (!open && !pending) store.getState().dismiss();
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          // The name is the one thing to change: the cursor goes there, with the name selected.
          event.preventDefault();
          input.current?.focus();
          input.current?.select();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.43]">{RENAME_DIALOG_TEXT.title}</AlertDialogTitle>
          <AlertDialogDescription>{RENAME_DIALOG_TEXT.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={NAME_INPUT_ID} className="font-medium">
            {RENAME_DIALOG_TEXT.label}
          </label>
          <Input
            ref={input}
            id={NAME_INPUT_ID}
            type="text"
            {...bidiProps}
            value={name}
            disabled={pending}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : PROBLEM_ID}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              // A form's Enter, without a form: the dialog's own button is the submit.
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              confirm();
            }}
          />
          {problem !== null && (
            <p id={PROBLEM_ID} role="alert" className="text-[13px] text-pretty text-destructive">
              {problem}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {RENAME_DIALOG_TEXT.cancel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={!readiness.ready || pending}
            aria-busy={pending}
            onClick={(event) => {
              // Radix would close the dialog now; it closes when the answer is in.
              event.preventDefault();
              confirm();
            }}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? RENAME_DIALOG_TEXT.confirming : RENAME_DIALOG_TEXT.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
