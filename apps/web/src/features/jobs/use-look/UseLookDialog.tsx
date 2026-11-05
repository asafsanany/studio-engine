import { ArrowRight, Loader2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { stillUrl } from '@/data';
import { cn } from '@/lib/utils';
import { LookStill, STILL_FRAME_CLASS } from './LookStill';
import type { NowLook } from './now-look';

/** The words of the dialog (design canvas, Phase 2: "Use this look · dialog"). */
export const USE_LOOK_DIALOG_TEXT = {
  cancel: 'Cancel',
  confirm: 'Use this look',
  now: 'Now',
  new: 'New',
  /** In the dashed frame of a style that was made from the client's files, not from a job. */
  fromFiles: 'From your files',
} as const;

interface UseLookDialogProps {
  open: boolean;
  client: string;
  /** The job whose look is offered (the "New" still), as it was when the dialog was asked for. */
  jobId: string;
  jobName: string;
  /** The client's current look (the "Now" still). */
  now: NowLook;
  /** "Use this look" was pressed and the answer is not in: both buttons are off and it cannot be closed. */
  saving: boolean;
  onConfirm: () => void;
  /** Cancel, Escape or a click outside (`false`). Not called while `saving`. */
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
  /** How long a wait must last before the stills show a skeleton. Tests pass 0. */
  skeletonDelayMs?: number;
}

interface CaptionProps {
  label: string;
  /** The job the look is from, in its own direction; `null`: the line is left out. */
  from: string | null;
}

/** "Now" / "New", and under it "from <job>". */
function Caption({ label, from }: CaptionProps) {
  return (
    <figcaption className="flex max-w-35 flex-col items-center text-center">
      <span className="font-medium">{label}</span>
      {from !== null && (
        <span className="line-clamp-2 text-[13px] wrap-anywhere text-muted-foreground">
          from <bdi>{from}</bdi>
        </span>
      )}
    </figcaption>
  );
}

/** The "Now" side: the still of the job the look comes from, or a dashed frame for a look made from files. */
function NowFigure({ now, skeletonDelayMs }: { now: NowLook; skeletonDelayMs?: number }) {
  const { now: label, fromFiles } = USE_LOOK_DIALOG_TEXT;
  if (now.kind === 'files') {
    return (
      <figure className="m-0 flex flex-col items-center gap-2 self-start">
        <div
          className={cn(
            STILL_FRAME_CLASS,
            'flex items-center justify-center border border-dashed border-input px-3 text-center text-[13px] text-muted-foreground',
          )}
        >
          {fromFiles}
        </div>
        <Caption label={label} from={null} />
      </figure>
    );
  }
  const jobId = now.kind === 'job' ? now.jobId : null;
  const name = now.kind === 'job' ? now.name : null;
  return (
    <figure className="m-0 flex flex-col items-center gap-2 self-start">
      <LookStill
        // Another job's still starts again from "not loaded".
        key={jobId ?? now.kind}
        src={jobId === null ? null : stillUrl(jobId)}
        label={name === null ? `${label} look` : `${label} look, from ${name}`}
        waiting={now.kind === 'loading'}
        skeletonDelayMs={skeletonDelayMs}
      />
      <Caption label={label} from={name} />
    </figure>
  );
}

/**
 * "Use this look for <client>?": the confirmation before a finished job becomes its client's style.
 * Under the question, the client's look now (the still of the job it comes from, or a dashed
 * "From your files" frame) and the look it would get (this job's still, ringed), joined by an
 * arrow. "Cancel" is the default (focused) outline button; "Use this look" turns into a spinner
 * until the server has answered. Names (client, jobs) sit in `<bdi>`, so Hebrew keeps its own
 * direction inside the English sentence.
 *
 * Presentational: `UseLookDialogHost` owns the state and the request.
 */
export function UseLookDialog({
  open,
  client,
  jobId,
  jobName,
  now,
  saving,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
  skeletonDelayMs,
}: UseLookDialogProps) {
  return (
    <AlertDialog
      open={open}
      // Escape or a click outside must not hide the dialog while the request is in flight.
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <AlertDialogContent
        // The board's dialog is 520 px wide, reads at a 1.5 line height (the page's is 1.43) and
        // spaces its parts by 20 px. (The width needs the data variant: the stock one has it too.)
        className="gap-5 leading-normal data-[size=default]:sm:max-w-[520px]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.4]">
            Use this look for <bdi>{client}</bdi>?
          </AlertDialogTitle>
          <AlertDialogDescription className="leading-normal text-pretty">
            The style for <bdi>{client}</bdi> is rewritten from the fonts, colours, titles, captions
            and graphics of <bdi>{jobName}</bdi>. The current style.md is kept in history, and
            finished jobs don’t change.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* The stills share one top edge (the "Now" of a look made from files has no "from" line, so
            its figure is shorter); the arrow sits in the middle of the row. */}
        <div className="flex items-center justify-center gap-5">
          <NowFigure now={now} skeletonDelayMs={skeletonDelayMs} />
          <ArrowRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          <figure className="m-0 flex flex-col items-center gap-2 self-start">
            <LookStill
              key={jobId}
              src={stillUrl(jobId)}
              label={`${USE_LOOK_DIALOG_TEXT.new} look, from ${jobName}`}
              highlighted
              skeletonDelayMs={skeletonDelayMs}
            />
            <Caption label={USE_LOOK_DIALOG_TEXT.new} from={jobName} />
          </figure>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={saving}>
            {USE_LOOK_DIALOG_TEXT.cancel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={saving}
            aria-busy={saving}
            onClick={(event) => {
              // Radix would close the dialog now; it closes when the answer is in.
              event.preventDefault();
              onConfirm();
            }}
          >
            {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
            {USE_LOOK_DIALOG_TEXT.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
