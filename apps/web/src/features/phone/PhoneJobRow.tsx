import {
  isArchived,
  isFolderDeleted,
  type Job,
  jobStage,
  relativeTime,
  stepLabel,
} from '@studio/shared';
import { Share } from 'lucide-react';
import { ROW_ACTION_ICONS } from '@/components/jobs/IconAction';
import { useNow } from '@/components/jobs/use-now';
import { Button } from '@/components/ui/button';
import { useDraftChatEnabled, useIsAdmin } from '@/data';
import { isRunning, rowOpensChat } from '@/features/job-chat/job-chat-logic';
import { ActionError } from '@/features/jobs/cells/ActionError';
import { ArchivedMarker } from '@/features/jobs/cells/ArchivedMarker';
import { JobEffortMarker } from '@/features/jobs/cells/EffortMarker';
import { NoteMarker } from '@/features/jobs/cells/NoteMarker';
import { type RowActions, useRowActions } from '@/features/jobs/cells/use-row-actions';
import { JobStatusIcon } from '@/features/jobs/JobStatusIcon';
import { askToMarkPaid } from '@/features/jobs/mark-paid/request';
import { canViewPreview, openPreview } from '@/features/review/preview-viewer';
import { openReview } from '@/features/review/review-dialog';
import { FollowsEpisode } from '@/features/series/FollowsEpisode';
import { SeriesMark } from '@/features/series/SeriesMark';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import {
  isFailedDetail,
  phoneDetail,
  type TreeFlags,
  treeContinues,
  treePosition,
} from './phone-jobs';
import { type PhoneNextStep as NextStep, phoneNextStep } from './phone-sheet';
import { useLongPress } from './use-long-press';

/** The countdown on an arriving job ("settles in 0:42") ticks every second, as on the Mac. */
const COUNTDOWN_TICK_MS = 1000;

const SEPARATOR = ' · ';

export interface PhoneJobRowProps {
  job: Job;
  /**
   * Where the row sits in its client's tree, in the By client view: the row is one step in, with
   * an elbow into its middle, and its second line leaves the client out. `undefined` is the flat
   * list, where the second line starts with the client.
   */
  tree?: TreeFlags;
  /**
   * Whether the second line starts with the client. By default it does in the flat list and not in
   * the tree; a client's own page (PH18) is flat and leaves it out.
   */
  showClient?: boolean;
  /** A tap on the row: opens the job's sheet. */
  onOpen: (jobId: string) => void;
}

/**
 * One job on the phone (board MJobs), at least 58 px tall, on a grid of the status icon, the job
 * and the next step: the status icon (`JobStatusIcon`); the name with the marks the Mac's row has
 * (the note, the effort, the series, and the box of an archived job); the second line, "client ·
 * detail · time" (or "detail · time" under the client's name); and at the right the next step as
 * a 44 px ghost button.
 *
 * A tap anywhere on the row but the button opens the job's sheet: a button laid over the row says
 * so to a screen reader ("Open <job>"), and the next-step button sits above it. With Draft & chat
 * on, a job in Review, waiting in line or running opens its chat (the phone Review) instead. Press
 * and hold (`useLongPress`, the phone's right-click) always opens the sheet, whose list is the row's
 * menu: that is where a job in Review is approved, never inside the Review. An archived row
 * is faded to 55% except for its tree line and its button. The next step is the phone's
 * (`phoneNextStep`), run through the Mac's row actions: Mark paid… (the Mac's dialog, until the
 * phone's sheet in PH16), Start now, Release, Retry from <step>, Resume; an Approved job's is Share
 * (Mobile 4), which opens its sheet, where the video is fetched and shared; and Review, whose Play
 * icon opens the phone Review (`openReview`). With no next step, a ready preview gets the Play icon.
 */
export function PhoneJobRow({ job, tree, showClient, onOpen }: PhoneJobRowProps) {
  const actions = useRowActions(job);
  const archived = isArchived(job);
  const muted = jobStage(job) === 'paid' || isFolderDeleted(job);
  const chat = rowOpensChat(job, useDraftChatEnabled());
  const hold = useLongPress(() => onOpen(job.id));

  return (
    <li
      data-job-id={job.id}
      data-archived={archived ? '' : undefined}
      data-folder-deleted={isFolderDeleted(job) ? '' : undefined}
      data-tree={tree === undefined ? undefined : treePosition(tree)}
      className={cn(
        'group/row relative grid min-h-[58px] grid-cols-[24px_minmax(0,1fr)_44px] items-center gap-2.5 py-1.5 pr-1.5 transition-colors duration-150 ease-in-out active:bg-muted/60',
        tree === undefined ? 'pl-4' : 'pl-11',
      )}
    >
      {tree !== undefined && (
        <>
          {/* The elbow: from the client's line down to the middle of this row, 7 px round. */}
          <span
            aria-hidden="true"
            className="absolute top-0 left-[27.5px] h-[calc(50%+0.5px)] w-[15px] rounded-bl-[7px] border-b border-l border-[#3F3F46]"
          />
          {/* The line on to the next job; the last one ends at its elbow. */}
          {treeContinues(tree) && (
            <span
              aria-hidden="true"
              className="absolute top-1/2 bottom-0 left-[27.5px] border-l border-[#3F3F46]"
            />
          )}
        </>
      )}
      <button
        type="button"
        aria-label={`Open ${job.name}`}
        {...hold.handlers}
        onClick={() => {
          // The finger was held: the sheet is open already.
          if (hold.takeHold()) return;
          if (chat) openReview(job.id);
          else onOpen(job.id);
        }}
        className="absolute inset-0 z-[1] outline-none focus-visible:bg-muted/60"
      />
      <span className="flex justify-center group-data-[archived]/row:opacity-55">
        <JobStatusIcon job={job} />
      </span>
      <div className="flex min-w-0 flex-col gap-px group-data-[archived]/row:opacity-55">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* `.bidi` is for one line with an ellipsis; the name here wraps, as in the sheet. */}
          <Bidi
            className={cn(
              'overflow-visible text-[15px] leading-5 font-medium break-words whitespace-normal',
              muted && 'text-muted-foreground',
            )}
          >
            {job.name}
          </Bidi>
          {job.note !== null && <NoteMarker note={job.note} />}
          <JobEffortMarker job={job} />
          {job.seriesId !== null && <SeriesMark job={job} />}
          {job.archivedAt !== null && <ArchivedMarker archivedAt={job.archivedAt} />}
        </div>
        <PhoneJobDetail job={job} showClient={showClient ?? tree === undefined} />
      </div>
      <PhoneNextStep job={job} actions={actions} onOpen={onOpen} />
    </li>
  );
}

/**
 * The row's second line, muted 13 px: "client · detail · time" in the flat list, "detail · time"
 * under the client's name. It wraps to a second line rather than cutting the time off. The detail
 * is the Mac's (`phoneDetail`; an editing episode says which episode of its series it follows, as
 * on the Mac); a failed job's is red. The time is "12 min ago", kept current by the Mac's shared
 * clock.
 */
function PhoneJobDetail({ job, showClient }: { job: Job; showClient: boolean }) {
  const now = useNow(job.state === 'arriving' ? COUNTDOWN_TICK_MS : undefined);
  const text = phoneDetail(job, now);
  const time = relativeTime(job.updatedAt, now);
  return (
    <p className="text-[13px] leading-[18px] text-pretty break-words text-muted-foreground tabular-nums">
      {showClient && (
        <>
          <bdi>{job.client}</bdi>
          {SEPARATOR}
        </>
      )}
      <span
        data-slot="job-detail"
        className={isFailedDetail(job) ? 'text-status-failed-foreground' : undefined}
      >
        {job.state === 'editing' && job.seriesId !== null ? (
          <FollowsEpisode job={job} text={text} step={stepLabel(job)}>
            {(follows) => follows}
          </FollowsEpisode>
        ) : (
          text
        )}
      </span>
      {time !== '' && (
        <>
          {SEPARATOR}
          <time dateTime={job.updatedAt} className="whitespace-nowrap">
            {time}
          </time>
        </>
      )}
    </p>
  );
}

/**
 * The row's right column: the one step that moves the job forward, a 44 px ghost icon button above
 * the row's tap area, or an empty 44 px cell for a job with none. A server action is disabled
 * while one of the job's requests is in flight, and a refusal explains itself under the button
 * (`ActionError`), as on the Mac. Share (an Approved job) opens the job's sheet: the share sheet
 * can only open once the video is in hand, and the sheet fetches it. A job in Review has the Play
 * icon, which opens the phone Review.
 */
function PhoneNextStep({
  job,
  actions,
  onOpen,
}: {
  job: Job;
  actions: RowActions;
  onOpen: (jobId: string) => void;
}) {
  const next = phoneNextStep(job, useIsAdmin());
  // Draft & chat: a job that waits in line or runs opens its chat from the Play icon.
  const chat = useDraftChatEnabled() && isRunning(job);
  const action: NextStep | null =
    next === null && chat ? { kind: 'review', label: 'Open the chat' } : next;
  const previewOnly = action === null && canViewPreview(job) && job.state !== 'review';
  const Icon = previewOnly
    ? ROW_ACTION_ICONS.review
    : action === null
      ? null
      : action.kind === 'share'
        ? Share
        : ROW_ACTION_ICONS[action.kind];
  return (
    <ActionError message={actions.refusal} onDismiss={actions.dismissRefusal}>
      <div
        data-row-actions={job.id}
        className="relative z-[2] flex size-11 items-center justify-center"
      >
        {Icon !== null && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={previewOnly ? 'View preview' : action?.label}
            disabled={
              action !== null &&
              action.kind !== 'pay' &&
              action.kind !== 'review' &&
              action.kind !== 'share' &&
              actions.busy
            }
            onClick={() => {
              if (previewOnly) {
                openPreview(job.id);
                return;
              }
              if (action === null) return;
              if (action.kind === 'review') openReview(job.id);
              else if (action.kind === 'share') onOpen(job.id);
              else if (action.kind === 'pay') askToMarkPaid(job);
              else actions.run(action);
            }}
            className="size-11 dark:hover:bg-accent"
          >
            <Icon className="size-5" />
          </Button>
        )}
      </div>
    </ActionError>
  );
}
