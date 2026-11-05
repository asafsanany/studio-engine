import type { Job, MusicView, TimeInput } from '@studio/shared';
import { Link } from '@tanstack/react-router';
import { useNow } from '@/components/jobs/use-now';
import { cn } from '@/lib/utils';
import { type DetailRow, detailRows, phoneDetailRows } from './sheet-details';
import {
  clientPageText,
  NO_REEL_LEAD,
  OPEN_REEL_TEXT,
  type SheetInstagram,
} from './sheet-instagram';
import type { SheetVariant } from './sheet-variant';

/** The link style of the On Instagram row: the canvas's blue, no underline until it has focus. */
const LINK_CLASS =
  'cursor-pointer rounded-xs text-blue-300 outline-none hover:text-blue-200 focus-visible:text-blue-200 focus-visible:underline';

/**
 * The value of a row: its text, and for a delivered job no reel links the sentence "No reel linked
 * yet. Link it from Falcon FPV’s page." with the client's page as the link (On Instagram, board S6).
 */
function RowValue({ row }: { row: DetailRow }) {
  const links = row.instagram;
  if (links?.kind !== 'none') return row.value;
  return (
    <>
      {NO_REEL_LEAD}
      <Link
        to="/clients/$clientId"
        params={{ clientId: links.clientId }}
        data-slot="sheet-client-page"
        className={LINK_CLASS}
      >
        {clientPageText(links.client)}
      </Link>
      .
    </>
  );
}

/** The second line of a row: its text, and for a linked reel "Open reel" at the end of it. */
function RowSub({ row, sub }: { row: DetailRow; sub: string }) {
  const links = row.instagram;
  if (links?.kind !== 'reel' || links.url === null) return sub;
  return (
    <>
      {sub} ·{' '}
      <a
        href={links.url}
        target="_blank"
        rel="noopener noreferrer"
        data-slot="sheet-open-reel"
        className={LINK_CLASS}
      >
        {OPEN_REEL_TEXT}
      </a>
    </>
  );
}

/**
 * The sheet's "Details" part: money, video, file, inputs, music, added and folder, each only when
 * the job has a value for it (see `detailRows`). The label sits in a 96 px column. A value picks its
 * own reading direction and wraps anywhere, so a long mixed-language path never pushes the sheet
 * wider. A row can have a second line under its value (`sub`: the Music row's one line about the
 * music), muted and 13 px, in its own reading direction too; a `failure` row shows its value in the
 * failure colour (red) and keeps the second line muted.
 *
 * `now` and `timeZone` pin the clock and the zone (tests); without them the viewer's own are used.
 * Design: canvas page "Job sheet", board JSSheet (Details).
 *
 * On the phone (`variant="phone"`, boards MJobSheet*) the label column is 112 px and a row is 32 px
 * tall. A finished job there has the boards' shorter rows (`phoneDetailRows`: Steps, Inputs,
 * Approved and File; or Delivered, Price, Paid and File), with `stepsSummary` as its Steps.
 * `leadRows` come before the job's own rows: the phone puts a locked job's Effort there, since its
 * list leaves Effort out once the edit has started. `music` is the job's music (Soundtrack), which
 * the sheet passes only while the switch is on; it gives the Music row.
 *
 * `instagram` is what the sheet knows of Instagram (Clients × Instagram, `useSheetInstagram`), given
 * only while the switch is on: it gives the On Instagram row, with "Open reel" or the client's page
 * as links (board CLStates S6).
 */
export function JobSheetDetails({
  job,
  now,
  timeZone,
  variant = 'mac',
  leadRows = [],
  stepsSummary,
  music,
  instagram,
}: {
  job: Job;
  now?: TimeInput;
  timeZone?: string;
  variant?: SheetVariant;
  leadRows?: readonly DetailRow[];
  /** A finished job's "All 8 steps done · 26 min of work", for the phone's Steps row. */
  stepsSummary?: string | null;
  /** The job's music (`useJobMusic(job.id).data`), for the Music row. */
  music?: MusicView | null;
  /** The linked reel or "no reel yet" (`useSheetInstagram(job)`), for the On Instagram row. */
  instagram?: SheetInstagram | null;
}) {
  const clock = useNow();
  const phone = variant === 'phone';
  const at = now ?? clock;
  const own =
    (phone ? phoneDetailRows(job, at, timeZone, stepsSummary, music, instagram) : null) ??
    detailRows(job, at, timeZone, music, instagram);
  const rows = [...leadRows, ...own];
  if (rows.length === 0) return null;

  return (
    <section aria-label="Details" className="flex flex-col gap-0.5">
      <h3 className="mb-1.5 text-[13px] font-medium text-muted-foreground">Details</h3>
      <dl>
        {rows.map((row) => (
          <div
            key={row.label}
            data-detail={row.label}
            className={cn(
              'grid items-baseline gap-x-3',
              phone
                ? 'min-h-8 grid-cols-[112px_minmax(0,1fr)] py-1'
                : 'min-h-7 grid-cols-[96px_minmax(0,1fr)] py-[3px]',
            )}
          >
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              dir="auto"
              className={cn(
                'text-left tabular-nums [unicode-bidi:plaintext] wrap-anywhere',
                row.muted && 'text-muted-foreground',
                row.tone === 'failure' && 'text-status-failed-foreground',
              )}
            >
              <RowValue row={row} />
            </dd>
            {row.sub !== undefined && (
              <dd
                dir="auto"
                data-detail-sub={row.label}
                className="col-start-2 -mt-px text-left text-[13px] text-pretty text-muted-foreground [unicode-bidi:plaintext] wrap-anywhere"
              >
                <RowSub row={row} sub={row.sub} />
              </dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}
