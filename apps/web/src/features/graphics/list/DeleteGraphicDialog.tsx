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
import { GRAPHICS_TEXT } from './graphic-list';

interface DeleteGraphicDialogProps {
  open: boolean;
  /** The graphic's name, which stays in its own reading direction. */
  name: string;
  /** The delete is on its way: both buttons are disabled and the dialog cannot be closed. */
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Delete was pressed. The dialog stays open; the caller closes it when the engine has answered. */
  onConfirm: () => void;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
}

/**
 * "Delete “Name”?" (board GRLibrary, GRStates 3): what happens to the graphic, then Cancel (the
 * default, focused) and a red Delete that turns into a spinner with "Deleting…" until the engine
 * has answered. The graphic goes to the Trash, so it can be got back from there.
 */
export function DeleteGraphicDialog({
  open,
  name,
  pending = false,
  onOpenChange,
  onConfirm,
  onCloseAutoFocus,
}: DeleteGraphicDialogProps) {
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
          {/* leading-[1.43]: the board's title inherits the page's line height, not text-lg's 28 px. */}
          <AlertDialogTitle dir="auto" className="leading-[1.43]">
            Delete “<bdi>{name}</bdi>”?
          </AlertDialogTitle>
          <AlertDialogDescription>{GRAPHICS_TEXT.deleteBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {GRAPHICS_TEXT.cancel}
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
            {pending ? GRAPHICS_TEXT.deleting : GRAPHICS_TEXT.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
