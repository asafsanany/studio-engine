import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { cn } from '@/lib/utils';
import { PAGE_LINK_CLASS } from '@/pages/NotFoundPage';
import { ABOUT_COLUMN_WIDTH, CHAT_COLUMN_WIDTH } from './studio-columns';
import { STATE_TEXT } from './studio-text';

/**
 * The studio fills the window under the app's header: it cancels the page's own padding and is as
 * tall as what is left of the screen (but never shorter than the composer, the chat and a preview).
 */
export const STUDIO_FRAME =
  '-mx-6 -mt-6 -mb-10 flex h-[calc(100svh-3.5rem)] min-h-[560px] flex-col';

/** The frame every state of the page lives in. */
export function StudioFrame({
  graphicId,
  state,
  className,
  children,
}: {
  graphicId?: string;
  /** `loading`, `gone` or `unreachable`; absent when the studio itself is shown. */
  state?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="graphic-studio"
      data-graphic-id={graphicId}
      data-state={state}
      className={cn(STUDIO_FRAME, className)}
    >
      {children}
    </div>
  );
}

/**
 * The first load of a graphic: the three columns' outline at once, and grey placeholders only when
 * the wait has lasted a quarter of a second (a local answer is quicker, and placeholders that blink
 * in and out look like a flash).
 */
export function StudioLoading({ graphicId }: { graphicId: string }) {
  const showSkeleton = useDelayedFlag(true, SKELETON_DELAY_MS);
  return (
    <StudioFrame graphicId={graphicId} state="loading">
      <div className="h-14 flex-none border-b" />
      <div className="@container flex min-h-0 flex-1" aria-busy="true">
        <div className={cn('flex flex-none flex-col gap-4 border-r p-5', CHAT_COLUMN_WIDTH)}>
          {showSkeleton && (
            <>
              <Skeleton className="h-8 w-48 self-end" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-8 w-40 self-end" />
            </>
          )}
        </div>
        <div className="min-w-0 flex-1" />
        <div className={cn('flex flex-none flex-col gap-4 border-l p-5', ABOUT_COLUMN_WIDTH)}>
          {showSkeleton && (
            <>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </>
          )}
        </div>
      </div>
    </StudioFrame>
  );
}

/** A graphic that was deleted, or never existed (the engine answered 404). */
export function StudioGone({ graphicId }: { graphicId: string }) {
  return (
    <StudioFrame graphicId={graphicId} state="gone" className="items-center justify-center gap-1">
      <h1 className="m-0 text-lg font-semibold">{STATE_TEXT.goneTitle}</h1>
      <p className="m-0 text-muted-foreground">{STATE_TEXT.goneHint}</p>
      <Link to="/graphics" className={cn(PAGE_LINK_CLASS, 'mt-2')}>
        {STATE_TEXT.goneLink}
      </Link>
    </StudioFrame>
  );
}

/** The first load failed: nothing is on screen to keep showing. */
export function StudioUnreachable({
  graphicId,
  onRetry,
}: {
  graphicId: string;
  onRetry: () => void;
}) {
  return (
    <StudioFrame graphicId={graphicId} state="unreachable" className="items-center justify-center">
      <p className="m-0 text-muted-foreground">
        <span role="alert">{STATE_TEXT.unreachable}</span>{' '}
        <Button
          type="button"
          variant="link"
          onClick={onRetry}
          className="h-auto p-0 text-blue-300 underline hover:text-blue-200"
        >
          {STATE_TEXT.tryAgain}
        </Button>
      </p>
    </StudioFrame>
  );
}
