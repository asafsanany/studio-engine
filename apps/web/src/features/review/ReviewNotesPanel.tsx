import { type ReactNode, useId } from 'react';
import { REVIEW_DIALOG_TEXT } from './review-text';

/**
 * The notes column on the right of the review dialog: 360 px with its left border, a 52 px header
 * ("Notes" and how many) and a body that W10 fills with the list and the composer.
 */
export function ReviewNotesPanel({ count, children }: { count: number; children?: ReactNode }) {
  const headingId = useId();
  return (
    <section
      data-slot="review-notes"
      aria-labelledby={headingId}
      className="flex w-[360px] shrink-0 flex-col border-l"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-5">
        <h3 id={headingId} className="text-sm font-semibold">
          {REVIEW_DIALOG_TEXT.notes}
        </h3>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 text-xs font-medium tabular-nums">
          {count}
        </span>
      </div>
      <div data-slot="review-notes-body" className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </section>
  );
}
