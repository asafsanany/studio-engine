import { Loader2 } from 'lucide-react';
import type { ComponentProps } from 'react';
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
import type { CancelDialogNote } from '../cancel-dialog';

/** The words of the confirmation (design canvas, Components board: "Cancel confirmation"). */
export const CANCEL_DIALOG_TEXT = {
  title: 'Stop this edit?',
  description: 'Finished steps are kept, so you can resume later.',
  keep: 'Keep editing',
  stop: 'Stop edit',
  /** While the server waits for the editing process to end, which can take seconds. */
  stopping: 'Stopping…',
  /** The single button of a note (see `CancelDialogNote`). */
  ok: 'OK',
} as const;

interface CancelDialogProps {
  open: boolean;
  /** The cancel request is on its way: both buttons are disabled and the dialog cannot be closed. */
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Stop edit" was pressed. The dialog stays open; the caller closes it when the request ends. */
  onConfirm: () => void;
  /**
   * When set, the question is replaced by this note and an OK button (the edit ended by itself, the
   * job is gone, or the server refused the stop). OK closes through `onOpenChange(false)`.
   */
  note?: CancelDialogNote | null;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
}

/**
 * "Stop this edit?": the confirmation before a running edit is cancelled. "Keep editing" is the
 * default (focused) outline button; "Stop edit" is destructive and turns into a spinner with
 * "Stopping…" until the server has answered. With a `note` it says that instead, with one OK button.
 */
export function CancelDialog({
  open,
  pending,
  onOpenChange,
  onConfirm,
  note = null,
  onCloseAutoFocus,
}: CancelDialogProps) {
  return (
    <AlertDialog
      open={open}
      // Escape or a click outside must not hide the dialog while the request is in flight.
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          {/* leading-[1.43]: the canvas title inherits the page's 1.43 line height (25.7 px), not text-lg's 28 px. */}
          <AlertDialogTitle className="leading-[1.43]">
            {note?.title ?? CANCEL_DIALOG_TEXT.title}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {note?.description ?? CANCEL_DIALOG_TEXT.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {note ? (
            <AlertDialogAction autoFocus>{CANCEL_DIALOG_TEXT.ok}</AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel variant="outline" disabled={pending}>
                {CANCEL_DIALOG_TEXT.keep}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                aria-busy={pending}
                onClick={(event) => {
                  // Radix would close the dialog now; it closes when the answer is in.
                  event.preventDefault();
                  onConfirm();
                }}
              >
                {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
                {pending ? CANCEL_DIALOG_TEXT.stopping : CANCEL_DIALOG_TEXT.stop}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
