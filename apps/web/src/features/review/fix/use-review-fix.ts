import type { FixStatus, Job, ReviewNote } from '@studio/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useJobFixes, useQuickFixesEnabled } from '@/data';
import { type FixLanding, fixLanding, playerRev } from './fix-landing';
import { type FixPillPlan, fixPillPlan } from './fix-pill';

/** What Review's player (Mac and phone) needs of the job's quick fixes. */
export interface ReviewFix {
  /** What goes into the preview's address (`previewUrl`'s `fixRev`); `null` while no fix has landed or Quick fixes are off. */
  rev: number | null;
  /**
   * Set from the moment a fix lands (or is undone) while Review is open: the player that first
   * carries the new `rev` goes to the note's moment and stops there. `null` otherwise (nothing
   * landed, or the fixes were only read when Review opened).
   */
  landOn: FixLanding | null;
  /** The fix that runs and the ones that landed, for the pill on the video; `null` when there is nothing to draw. */
  pill: FixPillPlan | null;
}

/**
 * The job's quick fixes for Review's player: the `rev` in its address, where it lands when a fix
 * lands, and what the pill on the video shows. Inert, and nothing asked, while Quick fixes are off
 * or the job is not in Review.
 *
 * While `hold` is true the `rev` stays as it was: the dialog is fading out or a Send or Approve is on
 * its way, and the player must not reload for a change the engine makes after that (the round moves
 * on and the fixes of the last one are gone).
 *
 * The stills Compare shows are asked for as soon as a fix has landed, so holding Compare shows the
 * frame at once.
 */
export function useReviewFix({
  job,
  notes,
  hold = false,
}: {
  job: Pick<Job, 'id' | 'state'>;
  notes: readonly ReviewNote[] | undefined;
  hold?: boolean;
}): ReviewFix {
  const enabled = useQuickFixesEnabled();
  const { fixes, rev: hookRev } = useJobFixes(job.id, enabled && job.state === 'review');

  const live = playerRev(fixes, hookRev);
  const held = useRef(live);
  if (!hold) held.current = live;
  const rev = held.current;

  // The rev the player was last given, and each fix's state at the last look. The first rev the
  // player loads with is not a landing: Review opened with fixes already made, and the player starts
  // from the beginning as it always did. A fix that this page saw in another state is one it watched.
  const given = useRef(rev);
  const seen = useRef(new Map<string, FixStatus>());
  const [landing, setLanding] = useState<FixLanding | null>(null);
  useEffect(() => {
    const moved = rev !== given.current;
    const next = moved ? fixLanding({ rev, fixes, seen: seen.current, notes }) : null;
    given.current = rev;
    seen.current = new Map(fixes.map((fix) => [fix.id, fix.status]));
    if (moved) setLanding(next);
  }, [rev, fixes, notes]);

  const pill = useMemo(
    () => (enabled ? fixPillPlan({ jobId: job.id, fixes, notes }) : null),
    [enabled, job.id, fixes, notes],
  );

  const preloaded = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    for (const moment of pill?.changed ?? []) {
      if (moment.beforeSrc === null || preloaded.current.has(moment.beforeSrc)) continue;
      const image = new Image();
      image.src = moment.beforeSrc;
      preloaded.current.set(moment.beforeSrc, image);
    }
  }, [pill]);

  return { rev, landOn: landing !== null && landing.rev === rev ? landing : null, pill };
}
