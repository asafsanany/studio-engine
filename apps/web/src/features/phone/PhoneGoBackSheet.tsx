import { Loader2, Undo2 } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { SHEET_VERSIONS_TEXT } from '@/features/job-sheet/sheet-versions';
import { cn } from '@/lib/utils';
import { ignoreMessageTaps, PHONE_SHEET_CLASSES } from './phone-sheet-shell';

/**
 * "Go back to Cut 2?" as a bottom sheet: the Mac dialog's question (`GoBackDialog`), drawn for a
 * thumb. The grabber, the title with what stays in Versions under it, then a full-width 48 px
 * "Go back" and a "Cancel" under it. "Go back" turns into a spinner with "Going back…" until the
 * server has answered; the grabber, a tap on the dimmed page, Esc and Cancel close it, and none of
 * them while the request is on its way. It opens over the job sheet or the preview viewer, the
 * one that asked.
 */
export function PhoneGoBackSheet({
  open,
  question,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  question: { title: string; description: string };
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <Sheet
      open={open}
      // Escape or a tap outside must not hide the sheet while the request is in flight.
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <SheetContent
        ref={content}
        side="bottom"
        showCloseButton={false}
        data-slot="phone-go-back-sheet"
        className={cn(PHONE_SHEET_CLASSES, '[-webkit-tap-highlight-color:transparent]')}
        // The focus starts on the sheet itself: no button is lit by the tap that opened it.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={ignoreMessageTaps}
      >
        <SheetGrabber
          onClose={() => {
            if (!pending) onOpenChange(false);
          }}
          className="pt-2"
        />
        <div className="flex flex-col gap-1 px-4 pt-3.5 pb-4">
          <SheetTitle className="text-lg leading-[1.3]">{question.title}</SheetTitle>
          <SheetDescription className="text-sm">{question.description}</SheetDescription>
        </div>
        <div className="flex flex-col gap-2 px-4">
          <Button
            type="button"
            data-slot="phone-go-back-confirm"
            disabled={pending}
            aria-busy={pending}
            onClick={onConfirm}
            className="h-12 w-full text-[15px] [&_svg:not([class*='size-'])]:size-[18px]"
          >
            {pending ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Undo2 aria-hidden />
            )}
            {pending ? SHEET_VERSIONS_TEXT.going : SHEET_VERSIONS_TEXT.confirm}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="h-12 w-full text-[15px]"
          >
            {SHEET_VERSIONS_TEXT.keep}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
