import type { ReactNode } from 'react';

/** The review dialog's 64 px footer: a top border and room for the one action at a time (W10). */
export function ReviewFooter({ children }: { children?: ReactNode }) {
  return (
    <div
      data-slot="review-footer"
      className="flex h-16 shrink-0 items-center gap-3 border-t pr-4 pl-5"
    >
      {children}
    </div>
  );
}
