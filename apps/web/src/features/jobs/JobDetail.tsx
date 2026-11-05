import { clock, type Job, jobListDetail, parseCameraLutWait, stepLabel } from '@studio/shared';
import { useStore } from 'zustand';
import { useNow } from '@/components/jobs/use-now';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CAMERA_WAIT_DETAIL } from '@/features/luts/camera/camera-wait';
import { ImportLutLink } from '@/features/luts/camera/ImportLutLink';
import { FollowsEpisode } from '@/features/series/FollowsEpisode';
import { cn } from '@/lib/utils';
import { deliveryDetail, uploadedOwedText } from './delivery-text';
import { isWritingNote, noteDialogStore } from './note-dialog';

/** The countdown on an arriving job ("settles in 0:42") ticks every second. */
const COUNTDOWN_TICK_MS = 1000;

/** An editing job counts up how long its run has been going, so it ticks every second too. */
const RUNNING_TICK_MS = 1000;

/** What a job held by the "Note for the editor" dialog says: it waits for the person to write. */
export const WRITING_NOTE_DETAIL = 'Held · while you write a note';

/** One line of 13 px muted text, right aligned, with digits that do not jitter. */
const DETAIL_CLASSES =
  'text-right text-[13px] whitespace-nowrap text-muted-foreground tabular-nums';

/** The failed text's colour: the red the old badge used for its label. */
const FAILED_CLASSES = 'text-status-failed-foreground';

/**
 * The text of the row. An editing job's step is wrapped in `data-step-label` (the step with its
 * count: "Cut · graphics 2/5"), so tests can read how far the job has got without parsing the line;
 * the text on the page is `text` either way.
 */
function DetailText({ job, text }: { job: Job; text: string }) {
  const step = job.state === 'editing' ? stepLabel(job) : '';
  if (step === '' || !text.startsWith(step)) return text;
  return (
    <>
      <span data-step-label="">{step}</span>
      {text.slice(step.length)}
    </>
  );
}

/**
 * "Failed at Render" in red. With an error message the text is a button (so the keyboard reaches
 * it) and hovering or focusing it shows the message in a wide tooltip, below the text and starting
 * at its left edge. A failed job with no message is the same text without the tooltip.
 */
export function FailedDetail({ job, text }: { job: Pick<Job, 'error'>; text: string }) {
  if (job.error === null) {
    return (
      <span data-slot="job-detail" className={cn(DETAIL_CLASSES, FAILED_CLASSES)}>
        {text}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-slot="job-detail"
          className={cn(
            DETAIL_CLASSES,
            FAILED_CLASSES,
            'cursor-help rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
          )}
        >
          {text}
        </button>
      </TooltipTrigger>
      <TooltipContent wide side="bottom" align="start" sideOffset={6} dir="auto">
        {job.error}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A failed job that waits for a camera LUT (LU10) is not a failure to look at in red: its text is
 * "Waiting for a camera LUT" in the held amber, the sentence is in the tooltip, and a ghost button
 * "Import LUT" opens the LUTs page for it. Its error is the sentence the engine writes, so the
 * page finds these jobs by reading it.
 */
export function CameraWaitDetail({ job }: { job: Pick<Job, 'id' | 'error'> }) {
  return (
    <span
      data-slot="job-detail"
      data-camera-wait=""
      className="flex items-center justify-end gap-1"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              DETAIL_CLASSES,
              'cursor-help rounded-sm text-status-held outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
            )}
          >
            {CAMERA_WAIT_DETAIL}
          </button>
        </TooltipTrigger>
        <TooltipContent wide side="bottom" align="start" sideOffset={6} dir="auto">
          {job.error}
        </TooltipContent>
      </Tooltip>
      <ImportLutLink jobId={job.id} />
    </span>
  );
}

/**
 * The detail of a job's row: what `jobListDetail` says for its state ("Cut · graphics 2/5 · ~4 min
 * left", "0:30 · 27 MB", "Failed at Render"), as muted text next to the time. A generated job has
 * its own words ("Generate · clips 4/6 · $1.65", "Higgsfield balance is empty", "Ready to review ·
 * 0:35 · 1 clip below the bar"). A delivered job says
 * when it was delivered and what it is owed ("Delivered 21 Oct · ₪40 not paid"), a paid one when
 * the money came in ("Paid 23 Oct · ₪40"), an uploaded one when its reel was posted and its plays
 * ("Posted Tue 20 Oct · 27.5K plays", the money in a tooltip), all in the browser's local days
 * (`deliveryDetail`). A
 * job the note dialog is holding while the person writes says why it waits. A failed job's text is
 * red and carries its error in a tooltip. An editing episode of a series says which episode of the
 * series' format it follows ("Cut · follows episode 5 · ~2 min left").
 *
 * Only an arriving job's countdown and an editing job's "running 3:42" read the clock, and only
 * those rows run the one-second one, so a page of ready jobs adds no timers.
 */
export function JobDetail({ job }: { job: Job }) {
  const runningSince = job.state === 'editing' ? (job.runningSince ?? null) : null;
  const now = useNow(
    job.state === 'arriving'
      ? COUNTDOWN_TICK_MS
      : runningSince === null
        ? undefined
        : RUNNING_TICK_MS,
  );
  // Held by the note dialog (not by the person): the text says why it waits.
  const writing = useStore(noteDialogStore, (state) => isWritingNote(state, job.id));
  const baseText =
    writing && job.state === 'held'
      ? WRITING_NOTE_DETAIL
      : (deliveryDetail(job) ?? jobListDetail(job, now));
  const text =
    runningSince === null
      ? baseText
      : `${baseText} · running ${clock((now - Date.parse(runningSince)) / 1000)}`;

  if (job.state === 'failed') {
    return parseCameraLutWait(job.error) === null ? (
      <FailedDetail job={job} text={text} />
    ) : (
      <CameraWaitDetail job={job} />
    );
  }
  if (job.state === 'editing' && job.seriesId !== null) {
    return (
      <FollowsEpisode job={job} text={text} step={stepLabel(job)}>
        {(follows) => (
          <span data-slot="job-detail" className={DETAIL_CLASSES}>
            <DetailText job={job} text={follows} />
          </span>
        )}
      </FollowsEpisode>
    );
  }
  const owed = uploadedOwedText(job);
  if (owed !== null) return <UploadedDetail text={text} owed={owed} />;
  return (
    <span data-slot="job-detail" className={DETAIL_CLASSES}>
      <DetailText job={job} text={text} />
    </span>
  );
}

/**
 * An Uploaded job's row says how its reel is doing ("Posted Tue 20 Oct · 27.5K plays"), so what it
 * is still owed ("₪40 not paid") is in a tooltip, and in the job sheet. A mouse extra: the next
 * step on the row (Mark paid) and the sheet say the same to everyone else.
 */
function UploadedDetail({ text, owed }: { text: string; owed: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-slot="job-detail" className={DETAIL_CLASSES}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" sideOffset={6}>
        {owed}
      </TooltipContent>
    </Tooltip>
  );
}
