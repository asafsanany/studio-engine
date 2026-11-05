import type { Effort } from '@studio/shared';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FooterView } from './notes-logic';
import { ReviewEffortMenu } from './ReviewEffortMenu';

interface ReviewFooterActionsProps {
  view: FooterView;
  /** The server's reason for the last refused Send; replaces the muted text. */
  error: string | null;
  onSend: () => void;
  /**
   * The job's effort and how to change it. When given, the footer shows the Effort button before
   * "Send N notes" (the fixes round uses the level), and not with no notes. With Quick fixes on
   * (`auto`) the value is the job's review effort, whose `null` is Auto, and the button also shows
   * with no notes, since Auto decides what happens to the next note.
   */
  effort?: {
    value: Effort | null;
    onChange: (effort: Effort | null) => void;
    auto?: boolean;
  };
}

/**
 * What the review dialog's footer holds: one line of text and, with notes, "Send N notes" (board
 * P3Review). The button is 36 px tall with 16 px at the sides. With no notes there is no button:
 * Approve is in the row's right-click menu only (the owner, 31 Oct), and the line says so. A refusal
 * from the server takes the place of the text. With notes, the Effort button sits before Send
 * (board "Review" of the Effort page). With Quick fixes on, a note being read or a fix under way
 * holds Send and the Effort button (`view.effortDisabled`), and the tooltip says "Wait for the fix
 * to finish".
 */
export function ReviewFooterActions({ view, error, onSend, effort }: ReviewFooterActionsProps) {
  const button =
    view.action === 'send_notes' ? (
      <Button
        type="button"
        data-action={view.action}
        disabled={view.disabled}
        aria-busy={view.busy}
        className="has-[>svg]:px-4"
        onClick={onSend}
      >
        {view.busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Send />}
        {view.label}
      </Button>
    ) : null;

  return (
    <>
      {error === null ? (
        <p data-slot="review-footer-text" className="min-w-0 flex-1 text-muted-foreground">
          {view.text}
        </p>
      ) : (
        <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
          {error}
        </p>
      )}
      {effort !== undefined && (view.action === 'send_notes' || effort.auto === true) && (
        <ReviewEffortMenu
          effort={effort.value}
          onChange={effort.onChange}
          disabled={view.busy || view.effortDisabled === true}
          auto={effort.auto === true}
        />
      )}
      {button === null ? null : view.disabledReason === null ? (
        button
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button gets no pointer events, so the tooltip hangs on the span around it. */}
            <span
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled button can't take focus, so the tooltip opens from this wrapper
              tabIndex={0}
              className="inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
            >
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="end" sideOffset={6}>
            {view.disabledReason}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
