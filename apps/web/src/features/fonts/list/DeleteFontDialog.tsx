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
import { deleteAfterText, FONT_LIST_TEXT } from './font-list';

interface DeleteFontDialogProps {
  open: boolean;
  /** The family's name, which stays in its own reading direction. */
  name: string;
  /** What the first sentence says: how many jobs use it and that all its weights go. */
  body: string;
  /** Notes can name a font (`fontsInNotes` on): the second paragraph also says notes that name it stop working. */
  inNotes: boolean;
  /** The delete is on its way: both buttons are disabled and the dialog cannot be closed. */
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Delete was pressed. The dialog stays open; the caller closes it when the engine has answered. */
  onConfirm: () => void;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
}

/**
 * "Delete “Heebo”?" (board FOStates 8): how many jobs use the family and that all its weights go,
 * what videos already made, a retry and notes do afterwards, and that it goes to the Trash (the
 * use count and the notes wait until notes can name a font). Then
 * Cancel (the default, focused) and a red Delete that turns into a spinner with "Deleting…" until
 * the engine has answered.
 */
export function DeleteFontDialog({
  open,
  name,
  body,
  inNotes,
  pending = false,
  onOpenChange,
  onConfirm,
  onCloseAutoFocus,
}: DeleteFontDialogProps) {
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
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2.5">
              <p>{body}</p>
              <p>{deleteAfterText(inNotes)}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {FONT_LIST_TEXT.cancel}
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
            {pending ? FONT_LIST_TEXT.deleting : FONT_LIST_TEXT.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
