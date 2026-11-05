import { Loader2 } from 'lucide-react';
import { useRef } from 'react';
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
import { PhoneGoBackSheet } from '../phone/PhoneGoBackSheet';
import type { SheetVariant } from './sheet-variant';
import { goBackQuestion, SHEET_VERSIONS_TEXT } from './sheet-versions';

interface GoBackDialogProps {
  /** The cut to go back to, or `null` while the dialog is closed. */
  target: number | null;
  /** The cut the job is on now, which stays in Versions. */
  current: number | null;
  /** The restore is on its way: both buttons are disabled and the dialog cannot be closed. */
  pending: boolean;
  /** `phone` asks in a bottom sheet (`PhoneGoBackSheet`) with the same words and rules. */
  variant?: SheetVariant;
  onOpenChange: (open: boolean) => void;
  /** "Go back" was pressed. The dialog stays open; the caller closes it when the request ends. */
  onConfirm: () => void;
}

/**
 * "Go back to Cut 2?": the confirmation before a job in Review is put back on an earlier cut.
 * Nothing is lost, which the description says: the cut it leaves stays in Versions. "Cancel" is the
 * default (focused) outline button; "Go back" turns into a spinner with "Going back…" until the
 * server has answered. On the phone (`variant="phone"`) the same question is a bottom sheet.
 */
export function GoBackDialog({
  target,
  current,
  pending,
  variant = 'mac',
  onOpenChange,
  onConfirm,
}: GoBackDialogProps) {
  // While it fades out the dialog keeps the words it had: `target` is null once it is closed.
  const shown = useRef({ target: 0, current });
  if (target !== null) shown.current = { target, current };
  const question = goBackQuestion(shown.current.target, shown.current.current);
  if (variant === 'phone') {
    return (
      <PhoneGoBackSheet
        open={target !== null}
        question={question}
        pending={pending}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );
  }
  return (
    <AlertDialog
      open={target !== null}
      // Escape or a click outside must not hide the dialog while the request is in flight.
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.43]">{question.title}</AlertDialogTitle>
          <AlertDialogDescription>{question.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {SHEET_VERSIONS_TEXT.keep}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            aria-busy={pending}
            onClick={(event) => {
              // Radix would close the dialog now; it closes when the answer is in.
              event.preventDefault();
              onConfirm();
            }}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? SHEET_VERSIONS_TEXT.going : SHEET_VERSIONS_TEXT.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
