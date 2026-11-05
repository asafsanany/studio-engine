import type { Job } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { Archive } from 'lucide-react';
import { SheetTitle } from '@/components/ui/sheet';
import { useSeriesEnabled } from '@/data';
import { archivedDay } from '@/features/jobs/delivery-text';
import { useJobSeries, useSeriesText } from '@/features/series/SeriesMark';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { isDoneWith } from './job-sheet-status';
import type { SheetVariant } from './sheet-variant';

/** The page the sheet is on, which decides which of its links would only point at where you are. */
export interface JobSheetScope {
  /** A client's page (or one of its series' pages). */
  clientId?: string;
  /** A series' page. */
  seriesId?: string;
}

const LINK_CLASSES =
  'cursor-pointer rounded-xs outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline';

/** A muted dot between the parts of the line under the name. */
function Dot() {
  return <span aria-hidden="true">·</span>;
}

/**
 * The sheet's title: the job's name, and under it in muted text who it is for and where it belongs.
 *
 * - The name is 18 px and semibold, in its own direction (Hebrew, Latin or mixed), and wraps: a long
 *   name is never cut off. It is muted once the job is paid, as in the list. It is the sheet's
 *   accessible name.
 * - The client's name links to the client's page; on that client's own page it is plain text.
 * - An episode says its series and number ("מיתוס או אמת · episode 6") and links to the series'
 *   page, once series are on and the client's series have arrived; on that series' page it is
 *   plain text.
 * - A job made without footage says "Generated" (Generated videos, GN9).
 * - An archived job says when ("Archived 30 Sep"), with the archive icon.
 *
 * On the phone (`variant="phone"`) the name's line is 24 px, 2 px above the line of who it is for,
 * which is 14 px (boards MJobSheet*), and an episode says "Episode 6 of <series>" there, as the
 * row's mark does, in plain text: the series' page stays on the Mac.
 *
 * Must be inside the sheet (a `Sheet` root), whose dialog it names.
 */
export function JobSheetTitle({
  job,
  scope = {},
  variant = 'mac',
}: {
  job: Job;
  scope?: JobSheetScope;
  variant?: SheetVariant;
}) {
  const phone = variant === 'phone';
  const seriesOn = useSeriesEnabled();
  const series = useJobSeries(job);
  const seriesText = useSeriesText(job);
  const onClientPage = scope.clientId === job.clientId && scope.seriesId === undefined;
  const onSeriesPage = series !== null && scope.seriesId === series.id;
  const episode = job.episode === null ? '' : ` · episode ${job.episode}`;

  return (
    <div className={cn('flex flex-col', phone ? 'gap-0.5' : 'gap-1')}>
      <SheetTitle asChild>
        <Bidi
          as="h2"
          className={cn(
            // `.bidi` is for one line with an ellipsis; the name here wraps.
            'overflow-visible text-[18px] font-semibold wrap-anywhere whitespace-normal',
            phone ? 'leading-6' : 'leading-[26px]',
            isDoneWith(job) && 'text-muted-foreground',
          )}
        >
          {job.name}
        </Bidi>
      </SheetTitle>
      <div
        className={cn(
          'flex flex-wrap gap-x-1.5 gap-y-1 text-muted-foreground',
          // The phone's series words can take two lines; the client stays at the top (MJobSheetEditing).
          phone ? 'items-start text-sm' : 'items-baseline text-[13px]',
        )}
      >
        {onClientPage ? (
          <bdi data-slot="job-sheet-client">{job.client}</bdi>
        ) : (
          <Link
            to="/clients/$clientId"
            params={{ clientId: job.clientId }}
            className={LINK_CLASSES}
            data-slot="job-sheet-client"
          >
            <bdi>{job.client}</bdi>
          </Link>
        )}
        {phone && seriesText !== null && (
          // Its words wrap inside their own box, under "Episode 6 of" (board MJobSheetEditing),
          // before the box moves to a line of its own: it takes what the client leaves on the line.
          <span className="flex flex-1 basis-0 items-center gap-x-1.5">
            <Dot />
            <span dir="auto" data-slot="job-sheet-series" className="[unicode-bidi:plaintext]">
              {seriesText.lead}
              {seriesText.name !== null && <bdi>{seriesText.name}</bdi>}
            </span>
          </span>
        )}
        {!phone && seriesOn && series !== null && (
          <>
            <Dot />
            {onSeriesPage ? (
              <span data-slot="job-sheet-series">
                <bdi>{series.name}</bdi>
                {episode}
              </span>
            ) : (
              <Link
                to="/clients/$clientId/series/$seriesId"
                params={{ clientId: job.clientId, seriesId: series.id }}
                className={LINK_CLASSES}
                data-slot="job-sheet-series"
              >
                <bdi>{series.name}</bdi>
                {episode}
              </Link>
            )}
          </>
        )}
        {job.generate != null && (
          <>
            <Dot />
            <span data-slot="job-sheet-generated-tag">Generated</span>
          </>
        )}
        {job.archivedAt !== null && (
          <>
            <Dot />
            <span className="inline-flex items-center gap-1" data-slot="job-sheet-archived">
              <Archive aria-hidden="true" className="size-3" />
              Archived {archivedDay(job.archivedAt)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
