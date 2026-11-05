import type { ClientStyleResponse } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { useMemo } from 'react';
import { RelativeTime } from '@/components/jobs/RelativeTime';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, jobsUnreachable, useClientStyle, useClients } from '@/data';
import { findClient, summarizeClients } from '@/features/clients/clients';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { StyleDocument } from '@/features/style/StyleDocument';
import { StyleStatusLine } from '@/features/style/StyleStatusLine';
import { styleStatus } from '@/features/style/style-status';
import { Bidi } from '@/lib/bidi';
import { NoSuchClient } from '@/pages/ClientPage';

/**
 * A client's Style page on the phone (board MStyle): `/clients/<id>/style` shows this in place of
 * the Mac's page on the phone layout. The style.md is read here and changed on the Mac: it is the
 * Mac's rendering of the file (`StyleDocument`) in a column the width of the phone, with no
 * "Add style files", no drop zone and no Retry. The line that says a run is going on, or has
 * failed, stays, so a style that is being learned reads as such.
 *
 * Top to bottom: the back link (44 px, the client's name, to its page) with "style.md · updated 1 h
 * ago" at the right; the document. A client with no style yet says so; an unknown client is "No
 * such client."; until the style has loaded the page is empty, with a skeleton after a moment, or
 * "Can't reach the engine." when the engine does not answer.
 */
export function PhoneStylePage({ clientId }: { clientId: string }) {
  const query = useClientStyle(clientId);
  const { data: style, error } = query;
  const { data: clients } = useClients();
  const unknown = error instanceof ApiError && error.status === 404;
  const unreachable = !unknown && jobsUnreachable(query);
  const showSkeleton = useDelayedFlag(
    style === undefined && !unknown && !unreachable,
    SKELETON_DELAY_MS,
  );
  // The name on the back link: the style's own once loaded, the client list's until then.
  const listed = useMemo(
    () => (clients ? findClient(summarizeClients(clients), clientId)?.name : undefined),
    [clients, clientId],
  );
  const name = style?.client ?? listed;

  return (
    <div
      data-slot="phone-style-page"
      className="-mx-4 -mt-4 flex flex-col [-webkit-tap-highlight-color:transparent]"
    >
      <div
        // Stays at the top of the scroller (below the notch, which the shell pads) while the page scrolls.
        className="sticky top-0 z-10 flex h-11 items-center justify-between gap-3 bg-background pr-4 pl-2"
      >
        <Button
          asChild
          variant="ghost"
          className="h-11 min-w-0 gap-0.5 pr-2.5 pl-1 text-[15px] font-medium has-[>svg]:pr-2.5 has-[>svg]:pl-1"
        >
          <Link to="/clients/$clientId" params={{ clientId }}>
            <ChevronLeft className="size-5 flex-none" aria-hidden="true" />
            {name === undefined ? 'Back' : <Bidi className="truncate">{name}</Bidi>}
          </Link>
        </Button>
        {style !== undefined && style.markdown !== null && (
          <span className="flex-none text-[13px] text-muted-foreground">
            style.md
            {style.updatedAt !== null && (
              <>
                {' · updated '}
                <RelativeTime
                  iso={style.updatedAt}
                  className="inline-block first-letter:lowercase"
                />
              </>
            )}
          </span>
        )}
      </div>

      {unknown ? (
        <div className="px-4 pt-4">
          <NoSuchClient />
        </div>
      ) : style !== undefined ? (
        <PhoneStyleView style={style} />
      ) : unreachable ? (
        <p role="alert" className="px-4 pt-2 text-muted-foreground">
          Can't reach the engine.
        </p>
      ) : (
        showSkeleton && <StyleSkeleton />
      )}
    </div>
  );
}

/** A loaded style: the status line when a run is going on or failed, then the document or "No style yet." */
export function PhoneStyleView({ style }: { style: ClientStyleResponse }) {
  const found = styleStatus(style, { upload: null, notice: null });
  // Read only: a failed run says why, and Retry is the Mac's.
  const status = found?.kind === 'error' ? { ...found, retry: false } : found;
  return (
    <article className="flex flex-col gap-2.5 px-4 pt-2 pb-8 text-[15px] leading-[1.6]">
      {status !== null && <StyleStatusLine status={status} onRetry={() => undefined} />}
      {style.markdown !== null ? (
        // The board's rhythm: 10 px between blocks, a title 22 px on 1.3 with 2 px under it, a section
        // heading with 14 px above it (the Mac's document has 12, 4 above and below, and 16).
        <div className="[&_[data-slot=style-document]]:gap-2.5 [&_h1]:mt-0 [&_h1]:mb-0.5 [&_h1]:text-[22px] [&_h1]:leading-[1.3] [&_h2]:pt-3.5 [&_p]:text-[15px]">
          <StyleDocument markdown={style.markdown} />
        </div>
      ) : (
        <div className="flex flex-col gap-1 pt-4 text-center">
          <p className="font-medium">No style yet.</p>
          <p className="text-pretty text-muted-foreground">
            Add files to <bdi>{style.client}</bdi>'s style on your Mac.
          </p>
        </div>
      )}
    </article>
  );
}

/** The document's place while the style is on its way: shown only once the wait is noticeable. */
function StyleSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 pt-2" aria-hidden="true">
      <Skeleton className="h-7 w-48 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-full motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
    </div>
  );
}
