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
import { deleteBodyText, LUT_LIST_TEXT } from './lut-list';

interface DeleteLutDialogProps {
  open: boolean;
  /** The LUT's name, which stays in its own reading direction. */
  name: string;
  /** Whether notes can name a LUT yet: it decides whether the body warns about them. */
  lutsInEdits: boolean;
  /** The delete is on its way: both buttons are disabled and the dialog cannot be closed. */
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Delete was pressed. The dialog stays open; the caller closes it when the engine has answered. */
  onConfirm: () => void;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
}

/**
 * "Delete “Name”?" (board LUPage, state `delete`): what happens to the LUT, then Cancel (the
 * default, focused) and a red Delete that turns into a spinner with "Deleting…" until the engine
 * has answered. The file goes to the Trash, so it can be got back from there.
 */
export function DeleteLutDialog({
  open,
  name,
  lutsInEdits,
  pending = false,
  onOpenChange,
  onConfirm,
  onCloseAutoFocus,
}: DeleteLutDialogProps) {
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
          <AlertDialogTitle dir="auto" className="leading-[1.43]">
            Delete “<bdi>{name}</bdi>”?
          </AlertDialogTitle>
          <AlertDialogDescription>{deleteBodyText({ lutsInEdits })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {LUT_LIST_TEXT.cancel}
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
            {pending ? LUT_LIST_TEXT.deleting : LUT_LIST_TEXT.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
