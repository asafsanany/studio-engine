import { Skeleton } from '@/components/ui/skeleton';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { cn } from '@/lib/utils';
import { EngagementCard, PlaysCard } from './ChartCards';
import { INSTAGRAM_HEADING_ID, InstagramHead } from './InstagramHead';
import { InstagramNoAccount, InstagramNoNumbers, InstagramNotices } from './InstagramStates';
import { InstagramTiles } from './InstagramTiles';
import type { TextOptions } from './instagram-text';
import { ReelsCard } from './ReelsCard';
import type { InstagramSectionState } from './use-instagram-section';

/**
 * The grey places of the section while the first answer is on its way (the head's title is real,
 * since it is known): four tiles and a chart of the sizes they will have, so the page does not jump.
 */
function InstagramSkeleton() {
  return (
    <section
      aria-labelledby={INSTAGRAM_HEADING_ID}
      aria-busy="true"
      className="flex flex-col gap-4"
    >
      <h2 id={INSTAGRAM_HEADING_ID} className="text-base leading-[1.43] font-semibold">
        Instagram
      </h2>
      <div className="grid grid-cols-1 gap-4 min-[640px]:grid-cols-2 min-[1200px]:grid-cols-4">
        {['followers', 'plays', 'likes', 'shares'].map((name) => (
          <Skeleton key={name} className="h-[130px] rounded-[12px] motion-reduce:animate-none" />
        ))}
      </div>
      <Skeleton className="h-[330px] rounded-[12px] motion-reduce:animate-none" />
    </section>
  );
}

/**
 * The Instagram section of a client's page, above its jobs (board CLPage): the head ("Scanned Mon
 * 26 Oct · next scan Mon 2 Nov", the range, Scan now), the four tiles, "Plays of every reel" and
 * "Views, likes, comments and shares".
 *
 * Nothing while the switch is off. A client with no account has the empty section (S8: Add
 * Instagram), and the other states (the first scan, a scan that can't run, none linked) have their
 * places in InstagramStates. The first answer shows grey places only once the wait is noticeable.
 * While another range loads the numbers on screen stay, a little dimmed.
 *
 * The Reels list (ReelsCard) is under the charts, in the same column.
 */
export function InstagramSection({
  clientId,
  state,
  textOptions,
}: {
  clientId: string;
  state: InstagramSectionState;
  textOptions?: TextOptions;
}) {
  const waiting = useDelayedFlag(state.on && state.loading, SKELETON_DELAY_MS);
  const { data } = state;
  if (!state.on) return null;
  if (data === undefined) return waiting ? <InstagramSkeleton /> : null;
  if (data.account === null) return <InstagramNoAccount clientId={clientId} />;

  const { numbers } = data;
  return (
    <section aria-labelledby={INSTAGRAM_HEADING_ID} className="flex flex-col gap-4">
      <InstagramHead
        clientId={clientId}
        data={data}
        range={state.range}
        onRangeChange={state.setRange}
        textOptions={textOptions}
      />
      {numbers === null ? (
        <InstagramNoNumbers data={data} clientId={clientId} textOptions={textOptions} />
      ) : (
        <>
          <InstagramNotices data={data} clientId={clientId} textOptions={textOptions} />
          <div
            aria-busy={state.stale}
            className={cn(
              'flex flex-col gap-4 transition-opacity duration-150 ease-in-out',
              state.stale && 'opacity-60',
            )}
          >
            <InstagramTiles numbers={numbers} textOptions={textOptions} />
            <PlaysCard numbers={numbers} reels={data.reels} textOptions={textOptions} />
            <EngagementCard numbers={numbers} reels={data.reels} textOptions={textOptions} />
            <ReelsCard key={clientId} clientId={clientId} data={data} textOptions={textOptions} />
          </div>
        </>
      )}
    </section>
  );
}
