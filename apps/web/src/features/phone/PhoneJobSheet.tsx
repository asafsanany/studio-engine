import { canEditEffort, isFolderDeleted, type Job, jobStage, type TimeInput } from '@studio/shared';
import { Check, ChevronLeft, ChevronRight, FolderX, Loader2, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ClientAvatar } from '@/components/ClientAvatar';
import { useNow } from '@/components/jobs/use-now';
import { EngineReconnecting } from '@/components/shell/EngineReconnecting';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SheetTitle } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import {
  useEngineReconnecting,
  useIsAdmin,
  useJobMusic,
  useJobSteps,
  useNoSong,
  useRetryNoSong,
  useSongsEnabled,
} from '@/data';
import { JobSheetDetails } from '@/features/job-sheet/JobSheetDetails';
import { JobSheetFiles } from '@/features/job-sheet/JobSheetFiles';
import { JobSheetGenerated } from '@/features/job-sheet/JobSheetGenerated';
import { JobSheetNotes } from '@/features/job-sheet/JobSheetNotes';
import { NowButtons, NowError } from '@/features/job-sheet/JobSheetNow';
import { SongPostSection } from '@/features/job-sheet/JobSheetSongFiles';
import { JobSheetStock } from '@/features/job-sheet/JobSheetStock';
import { JobSheetTitle } from '@/features/job-sheet/JobSheetTitle';
import { JobSheetVersions } from '@/features/job-sheet/JobSheetVersions';
import { sheetButtons, sheetError, sheetFiles } from '@/features/job-sheet/sheet-now';
import { sheetSongFiles } from '@/features/job-sheet/sheet-songs';
import { buildSteps } from '@/features/job-sheet/sheet-steps';
import { useSheetInstagram } from '@/features/job-sheet/use-sheet-instagram';
import {
  type RowActions,
  RowActionsContext,
  useRowActions,
} from '@/features/jobs/cells/use-row-actions';
import { useRowMenuEntries } from '@/features/jobs/row-menu-views';
import { canViewPreview, openPreview } from '@/features/review/preview-viewer';
import { cn } from '@/lib/utils';
import { PhoneShareVideo } from './PhoneShareVideo';
import {
  effortDetail,
  type PhoneItemRow,
  type PhoneMenuRow,
  type PhoneSubmenuRow,
  phoneMenuRows,
  songFileRows,
} from './phone-menu';
import {
  type PhonePill,
  type PhoneSteps,
  phoneMeta,
  phoneNextStep,
  phonePill,
  phoneSteps,
  segmentClasses,
} from './phone-sheet';
import { shareTargetFor } from './share-video';
import { songShare } from './song-share';
import { type ShareVideo, useShareVideo } from './use-share-video';

/** The arriving job's settle timer ticks every second, like the Mac sheet's. */
const COUNTDOWN_TICK_MS = 1000;

/** The pill's tone on top of the outline badge: amber for a hold, muted for a paid job (red is the destructive badge). */
const PILL_CLASSES: Record<PhonePill['tone'], string> = {
  default: '',
  amber: 'border-status-held/35 bg-status-held/8 text-amber-200',
  red: '',
  muted: 'text-muted-foreground',
};

/** The grabber: 36 × 5 px, centred above the header. A swipe down on it closes the sheet, like × and Back. */
function Grabber({ onClose }: { onClose: () => void }) {
  return <SheetGrabber onClose={onClose} className="pt-2" />;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Close"
      onClick={onClose}
      className="size-11 flex-none text-muted-foreground"
    >
      <X aria-hidden="true" className="size-5" />
    </Button>
  );
}

/** The pill (a dot and the state) and the muted line next to it. */
function StatusLine({ pill, meta }: { pill: PhonePill; meta: string }) {
  return (
    <div
      data-slot="phone-sheet-status"
      className="flex items-center gap-2 px-4 pt-3 whitespace-nowrap"
    >
      <Badge
        variant={pill.tone === 'red' ? 'destructive' : 'outline'}
        data-slot="job-sheet-status"
        data-tone={pill.tone}
        className={cn('h-[22px] rounded-[6px]', PILL_CLASSES[pill.tone])}
      >
        <BadgeDot className={pill.dot} />
        {pill.label}
      </Badge>
      {meta !== '' && (
        <span
          dir="auto"
          data-slot="phone-sheet-meta"
          className="min-w-0 truncate text-[13px] text-muted-foreground tabular-nums [unicode-bidi:plaintext]"
        >
          {meta}
        </span>
      )}
    </div>
  );
}

/** The step segments (eight, nine for a generated job) and the line under them. */
function Segments({ steps }: { steps: PhoneSteps }) {
  return (
    <div data-slot="phone-sheet-steps" className="mt-0.5 flex flex-col gap-2">
      <span aria-hidden="true" className="flex gap-[3px]">
        {segmentClasses(steps).map((segment) => (
          <span key={segment.id} className={cn('h-1.5 flex-1 rounded-[3px]', segment.className)} />
        ))}
      </span>
      <span dir="auto" className="[unicode-bidi:plaintext] tabular-nums">
        {steps.text}
      </span>
    </div>
  );
}

/** What a row of the list is made of: its icon, then (label, reason) and the value and chevron at the end. */
function RowContent({
  row,
  trailing,
}: {
  row: PhoneItemRow | PhoneSubmenuRow;
  trailing?: ReactNode;
}) {
  const Icon = row.icon;
  const destructive = row.kind === 'item' && row.destructive;
  return (
    <>
      <Icon
        aria-hidden="true"
        className={cn(
          'size-[18px] flex-none',
          destructive ? 'text-status-failed' : 'text-muted-foreground',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col items-start">
        {row.kind === 'item' && row.bidi !== undefined ? (
          <BidiLabel label={row.label} bidi={row.bidi} />
        ) : (
          <span>{row.label}</span>
        )}
        {row.kind === 'item' && row.reason !== null && (
          <span className="text-[13px] font-normal text-muted-foreground">{row.reason}</span>
        )}
        {row.kind === 'item' && row.detail !== undefined && (
          <span
            dir="auto"
            data-slot="menu-row-detail"
            className={cn(
              'text-left text-[13px] font-normal text-pretty [unicode-bidi:plaintext]',
              row.detailTone === 'failure'
                ? 'text-status-failed-foreground'
                : 'text-muted-foreground',
            )}
          >
            {row.detail}
          </span>
        )}
      </span>
      {trailing}
    </>
  );
}

/** The label with the person's own name (a client) in its own direction inside the English words. */
function BidiLabel({ label, bidi }: { label: string; bidi: string }) {
  const at = label.indexOf(bidi);
  if (at < 0) return <span>{label}</span>;
  return (
    <span>
      {label.slice(0, at)}
      <bdi>{bidi}</bdi>
      {label.slice(at + bidi.length)}
    </span>
  );
}

const ROW_CLASSES =
  'h-auto min-h-12 w-full justify-start gap-3 rounded-none px-4 py-0 text-left text-[15px] font-normal whitespace-normal has-[>svg]:px-4 hover:bg-white/5 active:bg-white/5 dark:hover:bg-white/5 disabled:opacity-50 [&_svg:not([class*="size-"])]:size-[18px]';

const CHEVRON = <ChevronRight aria-hidden="true" className="size-4 flex-none text-zinc-500" />;

/** One 48 px row of the list. A disabled one is at 50% (the reason, if it has one, under its label). */
function MenuRow({
  row,
  onOpenSubmenu,
}: {
  row: PhoneMenuRow;
  onOpenSubmenu: (id: string) => void;
}) {
  if (row.kind === 'submenu') {
    return (
      <Button
        type="button"
        variant="ghost"
        data-menu-row={row.id}
        aria-haspopup="true"
        disabled={row.disabled}
        onClick={() => onOpenSubmenu(row.id)}
        className={ROW_CLASSES}
      >
        <RowContent
          row={row}
          trailing={
            <>
              <span dir="auto" className="text-sm text-muted-foreground [unicode-bidi:plaintext]">
                {row.value}
              </span>
              {CHEVRON}
            </>
          }
        />
      </Button>
    );
  }
  const className = cn(
    ROW_CLASSES,
    row.destructive && 'text-status-failed-foreground',
    row.disabled && 'opacity-50',
  );
  if (row.busy === true) {
    // Something is being made (the file without the song): the label with a spinner, nothing to press.
    return (
      <div
        role="status"
        data-menu-row={row.id}
        className="flex min-h-12 w-full items-center gap-3 px-4 text-[15px] text-muted-foreground"
      >
        <Loader2
          aria-hidden="true"
          className="size-[18px] flex-none animate-spin motion-reduce:animate-none"
        />
        <span>{row.label}</span>
      </div>
    );
  }
  if (row.href !== null && !row.disabled) {
    return (
      <Button asChild variant="ghost" className={className}>
        <a href={row.href} download data-menu-row={row.id} onClick={row.onSelect}>
          <RowContent row={row} />
        </a>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      data-menu-row={row.id}
      aria-disabled={row.disabled || undefined}
      onClick={() => {
        if (!row.disabled) row.onSelect();
      }}
      className={className}
    >
      <RowContent row={row} />
    </Button>
  );
}

/** The job's menu as a flat list under a rule (the boards draw no lines between rows). */
export function MenuList({
  rows,
  onOpenSubmenu,
}: {
  rows: readonly PhoneMenuRow[];
  onOpenSubmenu: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      data-slot="phone-sheet-menu"
      className="mt-3 flex flex-col border-t border-white/[0.08] py-1"
    >
      {rows.map((row) => (
        <MenuRow key={row.id} row={row} onOpenSubmenu={onOpenSubmenu} />
      ))}
    </div>
  );
}

/**
 * A submenu opened inside the sheet (board MJobSheetEffort): "‹ Effort", its line of help, then
 * radio rows with the hint at the end and a check on the one in use. Choosing one goes back to the
 * list and tells the submenu's `onValueChange`.
 */
export function SubmenuView({ row, onBack }: { row: PhoneSubmenuRow; onBack: () => void }) {
  const { view } = row;
  return (
    <div
      data-slot="phone-sheet-submenu"
      className="mt-3 flex flex-col border-t border-white/[0.08] py-1"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        className="h-12 w-full justify-start gap-2 rounded-none pr-4 pl-2.5 text-[15px] font-semibold hover:bg-white/5 dark:hover:bg-white/5"
      >
        <ChevronLeft aria-hidden="true" className="size-5 text-muted-foreground" />
        {view.title}
      </Button>
      {view.hint !== null && (
        <p className="px-4 pb-2 text-[13px] text-pretty text-muted-foreground">{view.hint}</p>
      )}
      <div role="radiogroup" aria-label={view.title} className="flex flex-col">
        {view.options.map((option) => {
          const Icon = option.icon;
          return (
            <Button
              key={option.id}
              type="button"
              variant="ghost"
              role="radio"
              aria-checked={option.checked}
              data-option={option.id}
              onClick={() => {
                view.onPick(option.id);
                onBack();
              }}
              className={cn(
                ROW_CLASSES,
                'h-[52px] gap-3',
                option.ruleAbove && 'rounded-none border-t border-white/[0.08]',
              )}
            >
              {Icon !== null && (
                <Icon aria-hidden="true" className="size-[18px] flex-none text-muted-foreground" />
              )}
              <span className="flex-1">{option.label}</span>
              <span className="text-[13px] text-muted-foreground">{option.hint}</span>
              <span className="flex w-5 flex-none justify-center">
                {option.checked && <Check aria-hidden="true" className="size-[18px]" />}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Share video for an Approved job, with what a song adds (Songs): while the file without the song
 * is made the big button is a status ("Making the file without the song…") and nothing is fetched;
 * otherwise it is Share video, with a muted line under it saying which file it shares.
 */
function ShareVideoWithSong({
  job,
  share,
  actions,
  waiting,
  note,
}: {
  job: Job;
  share: ShareVideo;
  actions: RowActions;
  waiting: string | null;
  note: string | null;
}) {
  if (waiting !== null) {
    return (
      <div
        role="status"
        data-slot="share-making"
        className="flex h-12 items-center justify-center gap-2 rounded-md bg-primary/25 text-[15px] font-medium text-muted-foreground"
      >
        <Loader2
          aria-hidden="true"
          className="size-[18px] animate-spin motion-reduce:animate-none"
        />
        {waiting}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <PhoneShareVideo job={job} share={share} actions={actions} />
      {note !== null && (
        <p data-slot="share-song-note" className="text-[13px] text-pretty text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  );
}

export interface PhoneJobSheetProps {
  job: Job;
  /** The job list, for "Starts after <the job ahead>". */
  jobs: readonly Job[];
  /** Closes the sheet: × here, Back and the sheet's own dismissals in the host. */
  onClose: () => void;
  /** The clock (tests); the live one by default. */
  now?: TimeInput;
}

/**
 * The job sheet on the phone (boards MJobSheet*, canvas page Mobile): the Mac's job sheet as the
 * content of a bottom sheet. From the top: the grabber, the header (the client's avatar, the job's
 * name and who it is for, ×), the status line (a pill and a muted line), then
 *
 *   the step segments with their line · the failed job's error with Copy error · the next step as
 *   one 48 px button · the note for the editor (and the rounds of notes sent) · the row menu as 48 px
 *   rows (`phoneMenuRows`) · Details (a finished job's are the boards' shorter rows) · Versions
 *   (VE4: the Mac's part with `variant="phone"`, left out for a video whose folder is gone). A job
 *   made without footage (Generated videos) has its Generated part above Details, nine step
 *   segments, and a Download for each format of an approved job with more than one. The Mac's
 *   History is left out on the phone (the owner, CVP-277).
 *
 * Its words, rules and requests are the Mac sheet's: the sections are the Mac's with `variant="phone"`, the next step is `nextStepAction`, and the rows are `rowMenuEntries`, made by the same
 * `useRowActions` the Mac sheet has (one set of requests, shared with the list's row through
 * `RowActionsContext`). A row with a submenu (Effort) opens it inside the sheet.
 *
 * An Approved job's button is Share video instead of Mark delivered (`PhoneShareVideo`, Mobile 4):
 * the MP4 is fetched as the sheet opens and let go of when it closes, and after a share the sheet
 * asks "Sent it to <client>?". Mark delivered stays in the list.
 *
 * A video whose music is a song (Songs, board SGSheet) has two files: Download MP4 becomes a row for
 * each (`songFileRows`: with the song; without it, or "Making the file without the song…", or Try
 * again), "To post on Instagram" with a 44 px Copy sits under the big button, and Share video shares
 * the file without the song with the line as the share text (`songShare`).
 *
 * Must be inside the sheet's dialog (`Sheet`), which `JobSheetTitle` names with the job's name; key
 * it by the job's id so a new job starts on the list.
 */
export function PhoneJobSheet({ job, jobs, onClose, now }: PhoneJobSheetProps) {
  const actions = useRowActions(job);
  return (
    <RowActionsContext.Provider value={actions}>
      <PhoneSheetContent job={job} jobs={jobs} onClose={onClose} now={now} actions={actions} />
    </RowActionsContext.Provider>
  );
}

function PhoneSheetContent({
  job,
  jobs,
  onClose,
  now,
  actions,
}: PhoneJobSheetProps & { actions: RowActions }) {
  const clock = useNow(job.state === 'arriving' ? COUNTDOWN_TICK_MS : undefined);
  const reconnecting = useEngineReconnecting();
  // The phone's right-click menu is this list, so a job in Review has Approve here (never in Review).
  const entries = useRowMenuEntries(job, actions, { approve: true });
  const admin = useIsAdmin();
  const next = phoneNextStep(job, admin);
  // An Approved job's button is Share video, which fetches the MP4 as the sheet opens; where the
  // phone can't share it, the button is Download MP4. A Delivered or Paid job's list has a Share
  // video row in Download MP4's place, which fetches the MP4 on its first tap and shares it on the
  // next (U16).
  const approved = jobStage(job) === 'approved';
  // The job's music (Soundtrack) for Details' Music row and for the files of a song (Songs):
  // nothing is asked while the switch is off.
  const music = useJobMusic(job.id).data ?? null;
  // The linked reel's numbers for Details' On Instagram row (Clients × Instagram), asked only while the switch is on.
  const instagram = useSheetInstagram(job);
  // A video whose music is a song has two files (Songs): the rows below replace Download MP4, the
  // line to post sits under the big button, and Share video shares the file without the song.
  const songsOn = useSongsEnabled();
  const noSong = useNoSong(job.id, { enabled: job.state === 'ready' });
  const files = sheetSongFiles({
    job,
    songsOn,
    music,
    noSong: noSong.data,
    noSongFailed: noSong.isError,
  });
  const retry = useRetryNoSong(job.id);
  const songRows =
    files.kind === 'plain'
      ? null
      : songFileRows(files, {
          onTryAgain: () => retry.mutate(),
          pending: retry.isPending,
        });
  const songSharing = songShare(job, files);
  const share = useShareVideo(
    songSharing === undefined ? shareTargetFor(job, 'export') : songSharing.target,
    { eager: approved, asks: approved },
  );
  const rows = phoneMenuRows(
    entries,
    job,
    undefined,
    share.target === null ? null : { flow: share.flow, target: share.target, onShare: share.share },
    songRows,
  );
  // The submenu that is open, by id; one that has left the list (the job moved on) is closed.
  const [openSub, setOpenSub] = useState<string | null>(null);
  const sub = rows.find(
    (row): row is PhoneSubmenuRow => row.kind === 'submenu' && row.id === openSub,
  );

  const at = now ?? clock;
  const pill = phonePill(job);
  const steps = phoneSteps(job);
  const error = sheetError(job);
  // An Approved job's Details start with "All 8 steps done · 26 min of work", from its step runs.
  const runs = useJobSteps(job.id, { enabled: jobStage(job) === 'approved' });
  const stepsSummary =
    runs.data === undefined
      ? null
      : buildSteps(job, runs.data.runs, { now: new Date(at).getTime() }).summary;
  // A job that is editing has locked its level: the list leaves Effort out and Details says it.
  const leadRows =
    job.state === 'editing' && !canEditEffort(job)
      ? [{ label: 'Effort' as const, value: effortDetail(job), muted: false }]
      : [];

  return (
    <div
      data-slot="phone-job-sheet"
      className="flex flex-col [-webkit-tap-highlight-color:transparent]"
    >
      <Grabber onClose={onClose} />
      <div className="flex flex-none items-start gap-3 pt-3 pr-1.5 pl-4">
        <ClientAvatar client={job.client} size="lg" />
        <div className="min-w-0 flex-1 pt-px">
          <JobSheetTitle job={job} variant="phone" />
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <StatusLine pill={pill} meta={phoneMeta(job, jobs, at)} />
      {/* The line's room is only there while the line is (the empty live region has none). */}
      <EngineReconnecting reconnecting={reconnecting} className="px-4 has-[p]:pt-2" />

      {sub !== undefined ? (
        <SubmenuView row={sub} onBack={() => setOpenSub(null)} />
      ) : (
        <>
          {/* The boards' spacing: 14 px above the steps, 12 above an error and a note, 16 above the button. */}
          <div className="flex flex-col gap-3 px-4 pt-3 empty:hidden">
            {steps !== null && <Segments steps={steps} />}
            {error !== null && <NowError error={error} variant="phone" />}
            {(next !== null || (job.state !== 'review' && canViewPreview(job))) && (
              <div className="mt-1">
                {next?.kind === 'share' ? (
                  <ShareVideoWithSong
                    job={job}
                    share={share}
                    actions={actions}
                    waiting={songSharing?.waiting ?? null}
                    note={
                      share.flow.phase === 'unsupported' || share.flow.phase === 'failed'
                        ? (songSharing?.downloadNote ?? null)
                        : (songSharing?.note ?? null)
                    }
                  />
                ) : (
                  <NowButtons
                    job={job}
                    buttons={{ ...sheetButtons(job, admin), primary: next, download: null }}
                    actions={actions}
                    variant="phone"
                  />
                )}
              </div>
            )}
            <JobSheetFiles files={sheetFiles(job)} waiting={reconnecting} variant="phone" />
            {files.kind === 'files' && <SongPostSection text={files.post} variant="phone" />}
            <JobSheetNotes job={job} variant="phone" />
          </div>
          <MenuList rows={rows} onOpenSubmenu={setOpenSub} />
          <div
            className={cn(
              'flex flex-col gap-2 border-t border-white/[0.08] px-4 pt-3 pb-1',
              rows.length === 0 && 'mt-3',
            )}
          >
            <JobSheetGenerated job={job} variant="phone" />
            <JobSheetDetails
              job={job}
              variant="phone"
              leadRows={leadRows}
              stepsSummary={stepsSummary}
              music={music}
              instagram={instagram}
            />
            <JobSheetStock job={job} variant="phone" />
            {/* A video whose folder is gone has no versions to show (the Mac sheet leaves it out too). */}
            {!isFolderDeleted(job) && (
              <JobSheetVersions
                job={job}
                variant="phone"
                // The current cut is the live preview, which is what "View preview" shows too.
                onView={(version) => openPreview(job.id, version.current ? null : version.n)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Where the folder of a job that is gone was: "Studio Inbox/<client>/<name>" without the prefix. */
export function goneFolder(job: Pick<Job, 'client' | 'name'>): string {
  return `${job.client}/${job.name}`;
}

/**
 * "This job is gone": the job was open and its folder was removed from the inbox. The sheet stays
 * until the person closes it, with the words the Mac's sheet has. `last` is the job as it was seen.
 */
export function PhoneJobSheetGone({
  last,
  onClose,
}: {
  last: Pick<Job, 'client' | 'name'>;
  onClose: () => void;
}) {
  return (
    <div data-slot="phone-job-sheet" className="flex flex-col">
      <Grabber onClose={onClose} />
      <div className="flex flex-none items-center justify-end gap-3 pt-1 pr-1.5 pl-4">
        <CloseButton onClose={onClose} />
      </div>
      <div className="flex flex-col items-start gap-3 px-4 pt-2 pb-4">
        <FolderX aria-hidden="true" className="size-6 text-zinc-500" />
        <SheetTitle className="text-lg font-semibold">This job is gone</SheetTitle>
        <p className="text-muted-foreground">
          Its folder <bdi className="text-foreground/90">{goneFolder(last)}</bdi> was removed from
          Studio Inbox, so the engine let it go. Its export and money records are kept.
        </p>
        <Button type="button" variant="outline" className="h-11" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
