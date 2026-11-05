import type { Job, TimeInput } from '@studio/shared';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { useNow } from '@/components/jobs/use-now';
import { Button } from '@/components/ui/button';
import { useJobGenerateHistory } from '@/data/generate-query';
import { useJobSteps, useSentNotes } from '@/data/hooks';
import { useJobMusic } from '@/data/music-query';
import { useNoSong } from '@/data/no-song';
import { cn } from '@/lib/utils';
import { type HistoryRow, historyRows } from './sheet-history';
import type { HistoryTone } from './sheet-music';
import type { SheetVariant } from './sheet-variant';

/** What colour a row's text is, by its tone: the normal one, red for a failure, blue for something being made now, amber for a budget that ran out. */
const TONE_CLASSES: Record<HistoryTone, string> = {
  failure: 'text-status-failed-foreground',
  active: 'text-blue-300',
  warn: 'text-amber-400',
};

/** One row of the open history: its time, then what happened in its own reading direction. */
function HistoryItem({ row }: { row: HistoryRow }) {
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-3 py-1 text-[13px]">
      <span className="text-zinc-500 tabular-nums">{row.time}</span>
      <span
        dir="auto"
        className={cn(
          'text-left [unicode-bidi:plaintext] wrap-anywhere',
          row.tone ? TONE_CLASSES[row.tone] : 'text-zinc-300',
        )}
      >
        {row.text}
      </span>
    </li>
  );
}

/**
 * The sheet's "History" part: a full-width ghost button, closed at first, that opens the rows of
 * what happened to the job, oldest first (see `historyRows`). Nothing is asked of the engine until
 * it is open, and then only what the other parts already read: the job's step runs and, once a
 * round of notes was sent, the notes that were sent. Rows whose source has not arrived (or failed)
 * are left out quietly. Opened for one job it stays closed for the next one the sheet moves to.
 *
 * With Songs on it also says what the song's record knows (found, got, picked as trending, couldn't
 * get it) and that the file without the song was rendered, once it is made (`useNoSong`).
 *
 * `defaultOpen` starts it open (tests, the boards). `now` and `timeZone` pin the clock and the zone
 * (tests); without them the viewer's own are used. Design: canvas page "Job sheet", board JSSheet
 * (History), open on Failed (JSStatesA) and Delivered (JSStatesB). On the phone (`variant="phone"`)
 * the button is 44 px tall, a touch target.
 */
export function JobSheetHistory({
  job,
  defaultOpen = false,
  now,
  timeZone,
  variant = 'mac',
}: {
  job: Job;
  defaultOpen?: boolean;
  now?: TimeInput;
  timeZone?: string;
  variant?: SheetVariant;
}) {
  const [openFor, setOpenFor] = useState<string | null>(defaultOpen ? job.id : null);
  const open = openFor === job.id;
  const listId = useId();
  const clock = useNow();

  const steps = useJobSteps(job.id, { enabled: open });
  // The notes that were sent only matter once a round was sent. They are the same query the Notes
  // part and the review sentence read (`['sent-notes', id]`), not the Review dialog's draft list.
  const sent = useSentNotes(job.id, { enabled: open && job.round > 0 });
  // The job's music lines (Soundtrack): nothing is asked while the switch is off, and a job
  // without music.json answers null, which gives no lines.
  const music = useJobMusic(job.id, { enabled: open });
  // The second file of a video with a song (Songs): only a ready job has one, and nothing is asked
  // while Songs is off.
  const noSong = useNoSong(job.id, { enabled: open && job.state === 'ready' });
  // What the Generate stage did (Generated videos): only a job with a Generate stage has any.
  const generate = useJobGenerateHistory(job.id, { enabled: open && job.generate != null });

  const rows = open
    ? historyRows(
        {
          job,
          runs: steps.data?.runs,
          notes: sent.data?.notes,
          notesFailed: sent.isError,
          music: music.data ?? null,
          noSong: noSong.data ?? null,
          generate: generate.data,
        },
        now ?? clock,
        timeZone,
      )
    : [];

  return (
    <section aria-label="History" className="flex flex-col gap-0.5">
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpenFor(open ? null : job.id)}
        className={cn(
          '-mx-2 w-[calc(100%+1rem)] justify-between rounded-md px-2 text-[13px] font-medium text-muted-foreground has-[>svg]:px-2',
          variant === 'phone' ? 'h-11' : 'h-[30px]',
        )}
      >
        History
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 text-zinc-500 transition-transform duration-150 ease-in-out',
            open && 'rotate-180',
          )}
        />
      </Button>
      {open && (
        <ol id={listId} className="mt-1 flex flex-col">
          {rows.map((row) => (
            <HistoryItem key={row.id} row={row} />
          ))}
        </ol>
      )}
    </section>
  );
}
