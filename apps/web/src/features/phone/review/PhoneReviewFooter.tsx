import type { Effort } from '@studio/shared';
import { Check, ChevronDown, Loader2, Send } from 'lucide-react';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import { Button } from '@/components/ui/button';
import { reviewChoiceOf } from '@/features/jobs/effort-options';
import { cn } from '@/lib/utils';
import { PHONE_REVIEW_TEXT, type PhoneFooterView } from './phone-review';

interface PhoneReviewFooterProps {
  view: PhoneFooterView;
  /** The job's level, for the gauge on the Effort button. */
  effort: Effort | null;
  /** Quick fixes are on: `effort` is the review effort and `null` is Auto, which wears sparkles. */
  auto?: boolean;
  /** The server's reason for the last refused Send. */
  error: string | null;
  /** What Approve renders with no notes (both formats), said in muted text above the footer's line. */
  hint?: string | null;
  /** A rule above the footer: the notes list is open above it. */
  ruled: boolean;
  onSend: () => void;
  onOpenEffort: () => void;
  onClose: () => void;
}

/**
 * The phone Review's footer, one action at a time (boards MReview, MReviewNotes, MReviewDone): the
 * outlined "Effort: <level> ▾" and "Send N notes" with notes; the done line and Close after Send
 * went through. 48 px buttons, 16 px at the sides, and room for the home indicator under them. A
 * refusal from the server is said above the buttons. With Quick fixes on, a muted line above them
 * says what the notes are doing ("Fixing it here. Send waits for it.", "Auto sends 2 notes to Sonnet
 * at High, 2 to 10 min."); while a note is read or a fix runs Send and the Effort button wait (no
 * tooltip on a phone: the line says why). With no notes there is no button, only a line as tall as
 * one that says where Approve is: the row's sheet, by press and hold (the owner, 31 Oct).
 */
export function PhoneReviewFooter({
  view,
  effort,
  auto = false,
  error,
  hint = null,
  ruled,
  onSend,
  onOpenEffort,
  onClose,
}: PhoneReviewFooterProps) {
  const EffortIcon = auto ? effortIcon(reviewChoiceOf(effort)) : gaugeIcon(effort);
  return (
    <div
      data-slot="phone-review-footer"
      data-kind={view.kind}
      className={cn(
        'flex shrink-0 flex-col gap-2 border-t px-4 pt-1.5',
        // The boards' box is 60 px (1 + 6 + 48 + 5) with the rule clear while the list is shut, and
        // 124 px for the done line (12 px around it, Close at the foot), each above the home
        // indicator's room.
        view.kind === 'done'
          ? 'min-h-[calc(124px+var(--safe-bottom))] justify-between border-white/10 pt-3 pb-[calc(0.75rem+var(--safe-bottom))]'
          : ruled
            ? 'border-white/10 pb-[calc(5px+var(--safe-bottom))]'
            : 'border-transparent pb-[calc(5px+var(--safe-bottom))]',
      )}
    >
      {view.kind === 'done' ? (
        <>
          <div role="status" className="flex items-start gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-6 flex-none items-center justify-center rounded-full bg-[#34D399]/15 text-[#34D399]"
            >
              <Check className="size-3.5" strokeWidth={2.5} />
            </span>
            <span className="min-w-0 flex-1 text-sm leading-[1.4] text-pretty">{view.text}</span>
          </div>
          <Button
            key="close"
            type="button"
            variant="outline"
            className="h-11 w-full text-[15px]"
            onClick={onClose}
          >
            {PHONE_REVIEW_TEXT.close}
          </Button>
        </>
      ) : (
        <>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {error === null && (view.kind === 'send' ? view.note : hint) != null && (
            <p
              data-slot="phone-review-hint"
              role={view.kind === 'send' && view.note != null ? 'status' : undefined}
              className="text-[13px] text-muted-foreground"
            >
              {view.kind === 'send' ? view.note : hint}
            </p>
          )}
          {view.kind === 'send' ? (
            <div key="send" className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                data-slot="review-effort"
                aria-haspopup="dialog"
                disabled={view.busy || view.effortDisabled === true}
                onClick={onOpenEffort}
                className="h-12 flex-none gap-1.5 pr-2.5 pl-3 text-sm whitespace-nowrap has-[>svg]:pr-2.5 has-[>svg]:pl-3"
              >
                <EffortIcon aria-hidden="true" />
                {view.effortLabel}
                <ChevronDown aria-hidden="true" className="text-muted-foreground" />
              </Button>
              <Button
                type="button"
                data-action="send_notes"
                disabled={view.disabled}
                aria-busy={view.busy}
                onClick={onSend}
                className="h-12 min-w-0 flex-1 text-[15px] [&_svg:not([class*='size-'])]:size-[18px]"
              >
                {view.busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Send />}
                {view.label}
              </Button>
            </div>
          ) : (
            <p
              key="approve"
              data-slot="phone-review-approve"
              role="status"
              className="flex min-h-12 items-center text-sm leading-[1.4] text-pretty text-muted-foreground"
            >
              {view.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}
