import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CompareButton } from '../CompareButton';
import { type FixPillFit, type FixPillView, fixPillText } from './fix-pill';
import { FIX_PILL_TEXT } from './fix-pill-text';

interface FixPillProps {
  view: FixPillView;
  /** Compare is held: the video shows the moment as it was before the fix. */
  comparing: boolean;
  onCompare?(on: boolean): void;
  /** How the pill sits on the video (`fixPillFit`). Default `video`: the Mac's. */
  fit?: FixPillFit;
}

/** Where the pill is, and how big, for each fit. `video` is the font preview pill's. */
const PLACE: Record<FixPillFit, string> = {
  video: 'absolute bottom-2.5 left-2.5 h-[34px] max-w-[calc(100%-20px)]',
  // Finger-sized (a 32 px Compare in a 40 px pill) and as wide as its words, so a narrow video
  // does not cut them: `w-max` is the width of the words, not of what an absolute box has left.
  corner: 'absolute bottom-2.5 left-2.5 h-10 w-max',
  centered: 'absolute bottom-2.5 left-1/2 h-10 w-max -translate-x-1/2',
};

/** Compare in the phone's pill: 32 px high for a finger (the Mac's is 26). */
const PHONE_COMPARE = 'h-8';

/**
 * The pill on the video for a quick fix (board QFReview, states 3 to 5), at the bottom left of the
 * player's box like the font preview's, over the picture and its click catcher, so a click on it is
 * not a click on the video:
 *
 * - while a fix runs: a spinner and "Fixing at 0:12…", with no button (`role="status"`);
 * - after it, with the video paused at its moment: "Changed at 0:12" and the ghost Compare button,
 *   which shows the moment as it was while it is held (mouse or finger, or Space/Enter, which belong
 *   to it there: `data-own-keys`); the pill then says "Before the fix". The player draws the before
 *   still; a fix without one has no Compare button.
 *
 * Holding Compare changes the words, so the words keep the room of the longer one: the button does
 * not move out from under a pointer that is holding it.
 *
 * `fit` is how it sits (see `FixPillFit`): on the Mac it is never wider than the video and cuts its
 * words with "…"; on the phone the video can be 146 px wide (the notes list is open), so the pill is
 * 40 px high with a 32 px Compare, as wide as its words need, and reaches past the video's edge. The
 * player draws it outside the box that clips the picture for that.
 */
export function FixPill({ view, comparing, onCompare, fit = 'video' }: FixPillProps) {
  const phone = fit !== 'video';
  const cut = phone ? '' : 'truncate';
  if (view.kind === 'fixing') {
    return (
      <div
        role="status"
        data-slot="fix-pill"
        data-state="fixing"
        data-fit={fit}
        className={cn(
          PLACE[fit],
          'flex items-center gap-2 rounded-lg border border-white/[0.14] bg-[rgba(9,9,11,0.88)] px-3 text-xs whitespace-nowrap text-[#FAFAFA]',
        )}
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 flex-none animate-spin" />
        <span dir="ltr" className={cn('min-w-0', cut)}>
          {fixPillText(view, false)}
        </span>
      </div>
    );
  }
  const withCompare = view.beforeSrc !== null;
  const changed = fixPillText(view, false);
  const before = fixPillText(view, true);
  return (
    <div
      data-slot="fix-pill"
      data-state={comparing ? 'comparing' : 'changed'}
      data-fit={fit}
      data-own-keys=""
      className={cn(
        PLACE[fit],
        'flex items-center gap-1.5 rounded-lg border border-white/[0.14] bg-[rgba(9,9,11,0.88)] pl-3 text-xs whitespace-nowrap text-[#FAFAFA]',
        withCompare ? 'pr-1' : 'pr-3',
      )}
    >
      <span dir="ltr" className="grid min-w-0">
        <span className={cn('col-start-1 row-start-1', cut, comparing && 'invisible')}>
          {changed}
        </span>
        {withCompare ? (
          <span className={cn('col-start-1 row-start-1', cut, !comparing && 'invisible')}>
            {before}
          </span>
        ) : null}
      </span>
      {withCompare ? (
        <CompareButton
          comparing={comparing}
          onCompare={onCompare}
          tip={FIX_PILL_TEXT.compareTip}
          className={phone ? PHONE_COMPARE : undefined}
        />
      ) : null}
    </div>
  );
}
