import { clock } from '@studio/shared';
import { Loader2, Lock, PenLine } from 'lucide-react';
import { type ComponentProps, type ReactNode, useEffect, useRef } from 'react';
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
import { Input } from '@/components/ui/input';
import { stillUrl } from '@/data';
import { LookStill } from '@/features/jobs/use-look/LookStill';
import { bidiProps } from '@/lib/bidi';
import { nextEpisodeNames, type StartSeriesTarget } from './start-series-dialog';

/** The words of the dialog (design canvas, Series: "SeriesStart"). */
export const START_SERIES_DIALOG_TEXT = {
  cancel: 'Cancel',
  confirm: 'Start series',
  nameLabel: 'Series name',
  description:
    'Later episodes are rebuilt from this video’s composition. Each one brings only its own footage and words.',
  keptLead: 'Kept in every episode:',
  kept: 'the opening, titles and graphics, how the captions look, music, sounds and pacing.',
  newLead: 'New in each episode:',
  new: 'the footage, the on-screen text from the client’s brief, and captions from what’s said.',
} as const;

interface StartSeriesDialogProps {
  open: boolean;
  /** The job the series starts from, as it was when the dialog was asked for. */
  target: StartSeriesTarget | null;
  /** What is in the name input. */
  name: string;
  /** Why the name can't be used (the server's 422); shown under the input instead of the hint. */
  problem: string | null;
  /** "Start series" was pressed and the answer is not in: both buttons and the input are off. */
  saving: boolean;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  /** Cancel, Escape or a click outside (`false`). Not called while `saving`. */
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
  /** How long a wait must last before the still shows a skeleton. Tests pass 0. */
  skeletonDelayMs?: number;
}

const NAME_INPUT_ID = 'start-series-name';
const PROBLEM_ID = 'start-series-problem';

/** One line of "Kept" or "New": a muted icon, a bold lead and the sentence. */
function Point({ icon, lead, children }: { icon: ReactNode; lead: string; children: string }) {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <span className="text-pretty text-foreground/85">
        <span className="font-medium text-foreground">{lead}</span> {children}
      </span>
    </div>
  );
}

/**
 * "Start a series from <job>?": the confirmation before a ready job becomes the format of a new
 * series. On the left the job's still with its name and length; on the right the series name (a
 * text input, prefilled, with the two folder names that would join it under it), then what the
 * series keeps and what each episode brings. Under them, after a line, what happens to the
 * client's style. "Start series" is off while the name is empty and turns into a spinner until
 * the server has answered; a name the server refuses is explained under the input.
 *
 * Names (job, client, folders) sit in `<bdi>`, so Hebrew keeps its own direction inside the
 * English sentence. Presentational: `StartSeriesDialogHost` owns the state and the request.
 */
export function StartSeriesDialog({
  open,
  target,
  name,
  problem,
  saving,
  onNameChange,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
  skeletonDelayMs,
}: StartSeriesDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const text = START_SERIES_DIALOG_TEXT;
  const jobName = target?.jobName ?? '';
  const empty = name.trim() === '';
  const [next1, next2] = target === null ? ['', ''] : nextEpisodeNames(name, target);
  // A refused name sends the cursor back to the input (it was locked while the request ran), with
  // the name selected for the next try.
  useEffect(() => {
    if (problem === null || saving) return;
    input.current?.focus();
    input.current?.select();
  }, [problem, saving]);
  const duration = target?.durationSec ?? null;
  const length = duration === null ? null : clock(duration);
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
        // spaces its parts by 20 px.
        className="gap-5 leading-normal data-[size=default]:sm:max-w-[520px]"
        onOpenAutoFocus={(event) => {
          // The name is the one thing to decide: the cursor goes there, with the suggestion selected.
          event.preventDefault();
          input.current?.focus();
          input.current?.select();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.4]">
            Start a series from <bdi>{jobName}</bdi>?
          </AlertDialogTitle>
          <AlertDialogDescription className="leading-normal text-pretty">
            {text.description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-start gap-5">
          <figure className="m-0 flex flex-none flex-col items-center gap-2">
            {target !== null && (
              <LookStill
                // Another job's still starts again from "not loaded".
                key={target.jobId}
                src={stillUrl(target.jobId)}
                label={`A frame of ${jobName}`}
                skeletonDelayMs={skeletonDelayMs}
              />
            )}
            <figcaption className="max-w-36 text-center text-xs wrap-anywhere text-muted-foreground">
              <bdi>{jobName}</bdi>
              {length !== null && ` · ${length}`}
            </figcaption>
          </figure>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={NAME_INPUT_ID} className="font-medium">
                {text.nameLabel}
              </label>
              <Input
                ref={input}
                id={NAME_INPUT_ID}
                type="text"
                {...bidiProps}
                value={name}
                disabled={saving}
                aria-invalid={problem !== null}
                aria-describedby={problem === null ? undefined : PROBLEM_ID}
                onChange={(event) => onNameChange(event.target.value)}
                onKeyDown={(event) => {
                  // A form's Enter, without a form: the dialog's own button is the submit.
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (!empty && !saving) onConfirm();
                }}
              />
              {problem === null ? (
                <p className="text-[13px] text-pretty text-muted-foreground">
                  Folders named <bdi>{next1}</bdi>, <bdi>{next2}</bdi> and so on join it on their
                  own.
                </p>
              ) : (
                <p
                  id={PROBLEM_ID}
                  role="alert"
                  className="text-[13px] text-pretty text-destructive"
                >
                  {problem}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2.5 text-[13px]">
              <Point
                icon={
                  <Lock
                    aria-hidden="true"
                    className="mt-px size-4 shrink-0 text-muted-foreground"
                  />
                }
                lead={text.keptLead}
              >
                {text.kept}
              </Point>
              <Point
                icon={
                  <PenLine aria-hidden="true" className="mt-px size-4 shrink-0 text-blue-400" />
                }
                lead={text.newLead}
              >
                {text.new}
              </Point>
            </div>
          </div>
        </div>

        <p className="border-t pt-4 text-[13px] text-pretty text-muted-foreground">
          Whatever only this show does moves out of <bdi>{target?.client ?? ''}</bdi>’s style and
          into the series, so the client’s other videos stop picking it up. Finished videos don’t
          change.
        </p>

        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={saving}>
            {text.cancel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={saving || empty}
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
