import type { InstagramNumbers, InstagramReel } from '@studio/shared';
import { EngagementChart } from './EngagementChart';
import { ENGAGEMENT_CAP, ENGAGEMENT_LEGEND, engagementChartView } from './engagement-view';
import { InstagramCard, LegendRow } from './InstagramCard';
import type { TextOptions } from './instagram-text';
import { PlaysBarChart } from './PlaysBarChart';
import { PLAYS_LEGEND, playsChartView } from './plays-view';

/** What a chart card says when no reel was posted in the range. */
export const NO_REELS_IN_RANGE = 'No reels in this range.';

function NoReels() {
  return (
    <div className="flex min-h-24 items-center justify-center">
      <p className="text-sm text-muted-foreground">{NO_REELS_IN_RANGE}</p>
    </div>
  );
}

/**
 * "Plays of every reel": a bar for each reel of the range, ours blue and theirs grey, with the
 * typical reel of each side as a dashed line. The reels' captions are for the hover card.
 */
export function PlaysCard({
  numbers,
  reels,
  textOptions,
}: {
  numbers: InstagramNumbers;
  reels: readonly InstagramReel[];
  textOptions?: TextOptions;
}) {
  const view = playsChartView(numbers, reels, textOptions);
  return (
    <InstagramCard title="Plays of every reel" subtitle={view.subtitle}>
      {view.hasData ? (
        <>
          <LegendRow items={PLAYS_LEGEND} />
          <PlaysBarChart view={view} />
        </>
      ) : (
        <NoReels />
      )}
    </InstagramCard>
  );
}

/**
 * "Views, likes, comments and shares" (E1): each as a multiple of their usual reel on one axis, a
 * dashed line at 1×, a pale blue band behind each of our reels.
 */
export function EngagementCard({
  numbers,
  reels,
  textOptions,
}: {
  numbers: InstagramNumbers;
  reels: readonly InstagramReel[];
  textOptions?: TextOptions;
}) {
  const view = engagementChartView(numbers, reels, textOptions);
  return (
    <InstagramCard title="Views, likes, comments and shares" subtitle={view.subtitle}>
      {view.hasData ? (
        <>
          <LegendRow items={ENGAGEMENT_LEGEND} />
          <EngagementChart view={view} />
          {view.capped && (
            <p className="text-xs text-muted-foreground">
              Anything above {ENGAGEMENT_CAP}× is drawn at {ENGAGEMENT_CAP}×; hover a reel for the
              real number.
            </p>
          )}
        </>
      ) : (
        <NoReels />
      )}
    </InstagramCard>
  );
}
