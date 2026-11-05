import { isGeneratingNow, type Job } from '@studio/shared';
import { Check, Copy } from 'lucide-react';
import { createElement, useEffect, useRef, useState } from 'react';
import { ROW_ACTION_ICONS } from '@/components/jobs/IconAction';
import { useNow } from '@/components/jobs/use-now';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  useEngineReconnecting,
  useIsAdmin,
  useJobGenerateHistory,
  useJobMusic,
  useJobs,
  useNoSong,
  useSentNotes,
  useSongsEnabled,
} from '@/data';
import { ActionError } from '@/features/jobs/cells/ActionError';
import {
  type RowActions,
  useRowActions,
  useRowActionsContext,
} from '@/features/jobs/cells/use-row-actions';
import { copyError } from '@/features/jobs/copy-error';
import { askToMarkPaid } from '@/features/jobs/mark-paid/request';
import { ImportLutLink } from '@/features/luts/camera/ImportLutLink';
import { canViewPreview, openPreview } from '@/features/review/preview-viewer';
import { openReview } from '@/features/review/review-dialog';
import { cn } from '@/lib/utils';
import { JobSheetFiles } from './JobSheetFiles';
import { JobSheetSongFiles } from './JobSheetSongFiles';
import {
  type SheetBarTone,
  type SheetButtons,
  type SheetError,
  type SheetNowProgress,
  sheetButtons,
  sheetError,
  sheetFiles,
  sheetNow,
} from './sheet-now';
import { hasTwoFiles, sheetSongFiles } from './sheet-songs';
import type { SheetVariant } from './sheet-variant';

/** The countdown on an arriving job ("starts in 0:42") ticks every second, like its row's. */
const COUNTDOWN_TICK_MS = 1000;

/** The bar's fill, by tone: the track is the Progress's own. */
const TONE_CLASSES = {
  grey: '[&_[data-slot=progress-indicator]]:bg-zinc-500',
  blue: '[&_[data-slot=progress-indicator]]:bg-status-editing',
} as const satisfies Record<SheetBarTone, string>;

interface JobSheetNowProps {
  job: Job;
  /** An IANA zone to show times in (tests); the browser's own by default. */
  timeZone?: string;
}

/**
 * The sheet's "Now" part: one sentence on where the job is and what happens next, with a bar while
 * it waits, edits or renders; the failed job's whole error with Copy; and the buttons (the next
 * step, Download MP4 once there is one). Design: canvas page "Job sheet", boards JSSheet and
 * JSStatesA / JSStatesB. What each state says is `sheetNow` (sheet-now.ts).
 *
 * A video whose music is a song (Songs, board SGSheet) has two files after Approve: the two rows of
 * `JobSheetSongFiles` (with the song, to show the client; without it, to post) take Download MP4's
 * place, followed by the line to post with Copy. Songs off, no song picked, or no second file for the
 * job: the part is what it was (`sheetSongFiles`).
 *
 * The buttons go through the sheet's `RowActionsContext` (provided by the sheet from
 * `useRowActions(job)`), so a request sent here also disables the row's button, and a refusal is
 * explained under these buttons, where the press happened. Outside a sheet (a section on its own)
 * it makes its own actions.
 */
export function JobSheetNow({ job, timeZone }: JobSheetNowProps) {
  const shared = useRowActionsContext();
  return shared === null ? (
    <OwnActionsNow job={job} timeZone={timeZone} />
  ) : (
    <NowSection job={job} actions={shared} timeZone={timeZone} />
  );
}

function OwnActionsNow({ job, timeZone }: JobSheetNowProps) {
  const actions = useRowActions(job);
  return <NowSection job={job} actions={actions} timeZone={timeZone} />;
}

function NowSection({
  job,
  actions,
  timeZone,
}: JobSheetNowProps & {
  actions: RowActions;
}) {
  const now = useNow(job.state === 'arriving' ? COUNTDOWN_TICK_MS : undefined);
  const { data: jobs } = useJobs();
  // The buttons wait while the engine can't be reached (the sheet says so under its header).
  const waiting = useEngineReconnecting();
  // The notes of the round this review job is the result of, once the sent notes have arrived
  // (they share the `['sent-notes', id]` cache with the Notes and History parts). A round 0 job has
  // sent none, so nothing is asked.
  const sent = useSentNotes(job.id, { enabled: job.state === 'review' && job.round > 0 });
  const sentInRound = sent.data?.notes.filter((note) => note.round === job.round).length ?? 0;

  // The job's music (Soundtrack), for what the sentence says about it: nothing is asked while the
  // switch is off, and a job without music.json answers null.
  const music = useJobMusic(job.id);

  // A video whose music is a song has two files after Approve (Songs): the sheet shows both where
  // Download MP4 was, and the line to post with the second. Nothing is asked unless the job is
  // ready, and with Songs off nothing of it exists.
  const songsOn = useSongsEnabled();
  const noSong = useNoSong(job.id, { enabled: job.state === 'ready' });
  const songFiles = sheetSongFiles({
    job,
    songsOn,
    music: music.data,
    noSong: noSong.data,
    noSongFailed: noSong.isError,
  });

  // A generated job at work says when the stage began (its first History line); nothing is asked
  // for any other job.
  const generateHistory = useJobGenerateHistory(job.id, { enabled: isGeneratingNow(job) });
  const { sentence, progress } = sheetNow(job, jobs ?? [], now, {
    timeZone,
    sentNotes: sentInRound > 0 ? sentInRound : null,
    music: music.data,
    twoFiles: hasTwoFiles(songFiles),
    ...(generateHistory.data === undefined ? {} : { generateHistory: generateHistory.data }),
  });
  // A job with one video for each format (Generated videos) has a Download for each, in place of
  // the one Download MP4.
  const files = sheetFiles(job);
  const error = sheetError(job, timeZone);
  const admin = useIsAdmin();
  // The two rows take Download MP4's place (and so does the wait for them).
  const buttons = sheetButtons(job, admin);

  return (
    <div data-slot="job-sheet-now" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2.5">
        {/* Each part of the sentence (a Hebrew name inside English words) keeps its own direction. */}
        <p dir="auto" className="text-left text-zinc-200 [unicode-bidi:plaintext]">
          {sentence}
        </p>
        {progress === undefined ? null : <NowBar progress={progress} />}
      </div>
      {error === null ? null : <NowError error={error} />}
      <NowButtons
        job={job}
        buttons={
          songFiles.kind === 'plain' && files.length === 0
            ? buttons
            : { ...buttons, download: null }
        }
        actions={actions}
        waiting={waiting}
      />
      <JobSheetFiles files={files} waiting={waiting} />
      {songFiles.kind === 'files' && (
        <JobSheetSongFiles
          jobId={job.id}
          withSong={songFiles.withSong}
          noSong={songFiles.noSong}
          post={songFiles.post}
          waiting={waiting}
        />
      )}
    </div>
  );
}

/** The bar: a 6 px track and fill, with its name on the left and its note on the right. */
export function NowBar({ progress }: { progress: SheetNowProgress }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Progress
        value={progress.pct}
        aria-label={progress.label}
        data-tone={progress.tone}
        className={cn('h-1.5 bg-muted', TONE_CLASSES[progress.tone])}
      />
      <div className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span>{progress.label}</span>
        <span>{progress.right}</span>
      </div>
    </div>
  );
}

/** How long "Copied" stays on the phone's Copy error button. */
const COPIED_MS = 2000;

/** The phone's Copy error: a 44 px outline button that says "Copied" for two seconds once the text is on the clipboard. */
function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant="outline"
      data-sheet-copy=""
      className="h-11 self-start px-3 text-[15px]"
      onClick={() => {
        void copyError(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        });
      }}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-4', copied ? 'text-status-ready' : 'text-muted-foreground')}
      />
      {copied ? 'Copied' : 'Copy error'}
    </Button>
  );
}

/**
 * The failed job's error: red border, a faint red fill, the whole text, and Copy. On the Mac the
 * text is in mono under a title ("Failed at Render · 12:52") with a small Copy beside it; on the
 * phone (board MJobSheetFailed) it is plain text, the pill already says where it failed, and Copy
 * error is a button under it.
 */
export function NowError({
  error,
  variant = 'mac',
}: {
  error: SheetError;
  variant?: SheetVariant;
}) {
  if (variant === 'phone') {
    return (
      <div
        role="alert"
        data-slot="job-sheet-error"
        className="flex flex-col gap-2.5 rounded-lg border border-status-failed/30 bg-status-failed/6 p-3"
      >
        {error.help === undefined ? (
          <p dir="auto" className="text-left text-pretty wrap-anywhere [unicode-bidi:plaintext]">
            {error.text}
          </p>
        ) : (
          // A stop of the Generate stage: its title, code line and what to do (board GNSheet).
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-status-failed-foreground">{error.title}</span>
            <code className="block font-mono text-[13px] leading-[1.55] wrap-anywhere whitespace-pre-wrap text-zinc-200">
              {error.line}
            </code>
            <span className="text-[13px] text-pretty text-muted-foreground">{error.help}</span>
          </div>
        )}
        <CopyErrorButton text={error.text} />
      </div>
    );
  }
  // A job that waits for a camera LUT (LU10) is amber, not red, and can go and import one.
  const waiting = error.cameraWait !== undefined;
  return (
    <div
      role="alert"
      data-slot="job-sheet-error"
      data-camera-wait={waiting ? '' : undefined}
      className={cn(
        'flex flex-col gap-2 rounded-lg border pt-3 pr-2 pb-2.5 pl-3.5',
        waiting
          ? 'border-status-held/30 bg-status-held/8'
          : 'border-status-failed/30 bg-status-failed/8',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-[13px] font-medium',
            waiting ? 'text-status-held' : 'text-status-failed-foreground',
          )}
        >
          {error.title}
        </span>
        <span className="flex items-center gap-1">
          {waiting && error.jobId !== undefined && <ImportLutLink jobId={error.jobId} />}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-sheet-copy=""
            className="text-muted-foreground"
            onClick={() => void copyError(error.text)}
          >
            Copy
          </Button>
        </span>
      </div>
      <code className="block font-mono text-xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-zinc-200">
        {error.line ?? error.text}
      </code>
      {error.help !== undefined && (
        <span className="text-xs text-pretty text-muted-foreground">{error.help}</span>
      )}
    </div>
  );
}

/**
 * The next step with its name, View preview when one exists, and Download MP4 beside them. The
 * next step is the row's icon button with a label (`nextStepAction`): Review opens the review dialog and Mark paid… the payment
 * dialog, and neither waits for a request; the rest are requests, and wait for each other (`busy`,
 * shared with the row). Download takes the whole width when neither a next step nor preview exists.
 * While the engine can't be reached (`waiting`) every button waits, Review and Mark paid… and
 * Download too: they all need the engine.
 *
 * On the phone (`variant="phone"`) the next step is the sheet's one big button: 48 px tall, the
 * whole width, in the primary colour. Download MP4 is a row of the phone's list, so `buttons`
 * has none there.
 */
export function NowButtons({
  job,
  buttons,
  actions,
  waiting = false,
  variant = 'mac',
}: {
  job: Job;
  buttons: SheetButtons;
  actions: Pick<RowActions, 'run' | 'busy' | 'refusal' | 'dismissRefusal'>;
  /** The engine is out of reach: the buttons wait. */
  waiting?: boolean;
  variant?: SheetVariant;
}) {
  const { primary, download } = buttons;
  const viewPreview = job.state !== 'review' && canViewPreview(job);
  if (primary === null && download === null && !viewPreview) return null;

  const DownloadIcon = ROW_ACTION_ICONS.download;
  // Three buttons don't fit one row of the 420 px sheet: the next step takes a row, the other two
  // share the one below.
  const stacked = primary !== null && viewPreview && download !== null;
  return (
    <ActionError message={actions.refusal} onDismiss={actions.dismissRefusal}>
      <div className={cn('flex gap-2', variant === 'phone' ? 'flex-col' : stacked && 'flex-wrap')}>
        {primary === null ? null : (
          <Button
            type="button"
            data-sheet-action={primary.kind}
            disabled={
              waiting ||
              (primary.kind === 'review' || primary.kind === 'pay' ? false : actions.busy)
            }
            onClick={() => {
              if (primary.kind === 'review') openReview(job.id);
              else if (primary.kind === 'pay') askToMarkPaid(job);
              else actions.run(primary);
            }}
            className={
              variant === 'phone'
                ? "h-12 w-full text-[15px] [&_svg:not([class*='size-'])]:size-[18px]"
                : cn('flex-1 bg-zinc-50 text-zinc-900 hover:bg-zinc-200', stacked && 'basis-full')
            }
          >
            {createElement(ROW_ACTION_ICONS[primary.kind])}
            {primary.label}
          </Button>
        )}
        {viewPreview && (
          <Button
            type="button"
            variant="outline"
            data-sheet-action="view-preview"
            disabled={waiting}
            onClick={() => openPreview(job.id)}
            className={variant === 'phone' ? 'h-12 w-full' : stacked ? 'flex-1' : 'shrink-0'}
          >
            {createElement(ROW_ACTION_ICONS.review)}
            View preview
          </Button>
        )}
        {download === null ? null : (
          <Button
            asChild
            variant="outline"
            className={cn(
              primary === null || stacked ? 'flex-1' : 'shrink-0',
              waiting && 'pointer-events-none opacity-50',
            )}
          >
            <a
              href={waiting ? undefined : download.href}
              download
              data-sheet-download=""
              aria-disabled={waiting ? true : undefined}
              tabIndex={waiting ? -1 : undefined}
            >
              <DownloadIcon />
              {download.label}
            </a>
          </Button>
        )}
      </div>
    </ActionError>
  );
}
