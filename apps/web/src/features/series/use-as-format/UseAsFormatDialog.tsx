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
import { LookStill } from '@/features/jobs/use-look/LookStill';
import type { UseAsFormatTarget } from './use-as-format-dialog';

/** The words of the dialog (laid out like Phase 2's "Use this look · dialog"). */
export const USE_AS_FORMAT_DIALOG_TEXT = {
  cancel: 'Cancel',
  confirm: 'Use as format',
  now: 'Now',
  new: 'New',
} as const;

interface UseAsFormatDialogProps {
  open: boolean;
  /** The episode and the series, as they were when the dialog was asked for. */
  target: UseAsFormatTarget | null;
  /** "Use as format" was pressed and the answer is not in: both buttons are off and it cannot be closed. */
  saving: boolean;
  onConfirm: () => void;
  /** Cancel, Escape or a click outside (`false`). Not called while `saving`. */
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
  /** How long a wait must last before the stills show a skeleton. Tests pass 0. */
  skeletonDelayMs?: number;
}

/** "Now" / "New", and under it "from <job>". */
function Caption({ label, from }: { label: string; from: string }) {
  return (
    <figcaption className="flex max-w-35 flex-col items-center text-center">
      <span className="font-medium">{label}</span>
      <span className="line-clamp-2 text-[13px] wrap-anywhere text-muted-foreground">
        from <bdi>{from}</bdi>
      </span>
    </figcaption>
  );
}

/**
 * "Use <job> as the format?": the confirmation before another ready episode becomes the format of
 * its series. Under the question, the format now (the still of the job it comes from) and the
 * format it would get (this episode's still, ringed), joined by an arrow. "Cancel" is the default
 * (focused) outline button; "Use as format" turns into a spinner until the server has answered.
 * Names (episodes, series) sit in `<bdi>`, so Hebrew keeps its own direction inside the English
 * sentence.
 *
 * Presentational: `UseAsFormatDialogHost` owns the state and the request.
 */
export function UseAsFormatDialog({
  open,
  target,
  saving,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
  skeletonDelayMs,
}: UseAsFormatDialogProps) {
  const text = USE_AS_FORMAT_DIALOG_TEXT;
  const jobId = target?.jobId ?? '';
  const jobName = target?.jobName ?? '';
  const formatJobId = target?.formatJobId ?? '';
  const formatJobName = target?.formatJobName ?? '';
  return (
    <AlertDialog
      open={open}
      // Escape or a click outside must not hide the dialog while the request is in flight.
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <AlertDialogContent
        // The same 520 px, 1.5 line height and 20 px spacing as Use this look.
        className="gap-5 leading-normal data-[size=default]:sm:max-w-[520px]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.4]">
            Use <bdi>{jobName}</bdi> as the format?
          </AlertDialogTitle>
          <AlertDialogDescription className="leading-normal text-pretty">
            Later episodes of <bdi>{target?.seriesName ?? ''}</bdi> are rebuilt from the composition
            of <bdi>{jobName}</bdi> instead of <bdi>{formatJobName}</bdi>. The current series.md is
            kept in history, and finished episodes don’t change.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* The stills share one top edge; the arrow sits in the middle of the row. */}
        <div className="flex items-center justify-center gap-5">
          <figure className="m-0 flex flex-col items-center gap-2 self-start">
            <LookStill
              key={formatJobId}
              src={formatJobId === '' ? null : stillUrl(formatJobId)}
              label={`${text.now} format, from ${formatJobName}`}
              skeletonDelayMs={skeletonDelayMs}
            />
            <Caption label={text.now} from={formatJobName} />
          </figure>
          <ArrowRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          <figure className="m-0 flex flex-col items-center gap-2 self-start">
            <LookStill
              key={jobId}
              src={jobId === '' ? null : stillUrl(jobId)}
              label={`${text.new} format, from ${jobName}`}
              highlighted
              skeletonDelayMs={skeletonDelayMs}
            />
            <Caption label={text.new} from={jobName} />
          </figure>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={saving}>
            {text.cancel}
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
            {text.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
