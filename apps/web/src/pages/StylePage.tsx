import type { ClientStyleResponse } from '@studio/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ApiError, jobsUnreachable, useClientStyle, useRetryClientStyle } from '@/data';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { StyleLayout } from '@/features/style/StyleLayout';
import { useStyleSession, useWindowDrops } from '@/features/style/use-style-session';
import { NoSuchClient } from './ClientPage';

/** The column's place while the style is on its way: shown only once the wait is noticeable. */
function StyleSkeleton() {
  return (
    <div className="flex max-w-[680px] flex-col gap-3" aria-hidden="true">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <Skeleton className="h-4 w-44 motion-reduce:animate-none" />
        <Skeleton className="h-9 w-36 motion-reduce:animate-none" />
      </div>
      <Skeleton className="h-7 w-64 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-full motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
    </div>
  );
}

/** The client's style, loaded: the upload session, the drop on the window and Retry, over the layout. */
function StyleView({ style }: { style: ClientStyleResponse }) {
  const { session, state } = useStyleSession(style);
  const retry = useRetryClientStyle(style.clientId);
  const dragging = useWindowDrops(session.take);

  return (
    <StyleLayout
      style={style}
      session={state}
      dragging={dragging}
      retrying={retry.isPending}
      retryError={retry.error?.message ?? null}
      onFiles={session.take}
      onRetry={() => retry.mutate()}
      onChooseMode={session.chooseMode}
      onConfirm={session.confirm}
      onCancel={session.cancel}
    />
  );
}

/**
 * A client's Style page: its style.md rendered in a 680 px column, with a button (and a drop
 * anywhere on the page) to add files to it, or, while there is none, a drop zone in its place.
 * An unknown client is "No such client."; until the style has loaded the page is empty, with a
 * skeleton after a moment, or "Can't reach the engine." when the engine does not answer.
 */
export function StylePage({ clientId }: { clientId: string }) {
  const query = useClientStyle(clientId);
  const { data: style, error } = query;
  const unknown = error instanceof ApiError && error.status === 404;
  const unreachable = !unknown && jobsUnreachable(query);
  const showSkeleton = useDelayedFlag(
    style === undefined && !unknown && !unreachable,
    SKELETON_DELAY_MS,
  );

  if (unknown) return <NoSuchClient />;
  return (
    <TooltipProvider>
      {style !== undefined ? (
        <StyleView key={style.clientId} style={style} />
      ) : unreachable ? (
        <p role="alert" className="text-muted-foreground">
          Can't reach the engine.
        </p>
      ) : (
        showSkeleton && <StyleSkeleton />
      )}
    </TooltipProvider>
  );
}
