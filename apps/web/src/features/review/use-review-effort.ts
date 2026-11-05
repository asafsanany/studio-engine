import type { Effort, Job } from '@studio/shared';
import { toast } from 'sonner';
import { useQuickFixesEnabled, useSaveEffort, useSetReviewEffort } from '@/data';
import { REVIEW_DIALOG_TEXT } from './review-text';

/** What the Effort button of a Review (the Mac's dialog, the phone's sheet) needs. */
export interface ReviewEffortControl {
  /** The level to show: the job's review effort with Quick fixes on (`null` is Auto), else its effort (`null` is Default). */
  value: Effort | null;
  /** Quick fixes are on: `value` is the review effort, the menu has Auto and the button shows beside Approve too. */
  auto: boolean;
  /** Saves the chosen level (`null` for Auto or Default); a refusal is a toast with the server's reason. */
  onChange: (effort: Effort | null) => void;
}

/**
 * The Effort button's level and how it is changed, for a job in Review. While Quick fixes are off it
 * is today's: the job's `effort` (`PUT /effort`), whose `null` is Default. While they are on it is
 * the level of the review rounds, `reviewEffort` (`PUT /review-effort`), whose `null` is Auto. Either
 * shows the new choice at once (Quick fixes on) or when the server answers, and says why in a toast when
 * the server refuses.
 */
export function useReviewEffort(job: Job): ReviewEffortControl {
  const auto = useQuickFixesEnabled();
  const saveEffort = useSaveEffort();
  // Its refusal is said by the mutation itself (a toast, and the old level back).
  const setReviewEffort = useSetReviewEffort(job.id);
  return {
    value: auto ? job.reviewEffort : job.effort,
    auto,
    onChange(effort) {
      if (auto) {
        setReviewEffort.mutate(effort);
        return;
      }
      saveEffort.mutate(
        { id: job.id, effort },
        {
          onError: (error) =>
            toast.error(REVIEW_DIALOG_TEXT.effortFailed, { description: error.message }),
        },
      );
    },
  };
}
