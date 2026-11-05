import { type Job, reviewExportFileName } from '@studio/shared';
import { Download, Loader2, SquarePen, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { reviewExportFileUrl } from '@/data';
import { Bidi } from '@/lib/bidi';
import { exportWords } from './formats/format-logic';
import { MusicButton } from './music/MusicButton';
import { REVIEW_DIALOG_TEXT } from './review-text';
import { useReviewExport } from './use-review-export';

/**
 * The review dialog's 60 px header: the job and its client (each in its own text direction), the
 * "Live preview" badge, the Music button (Soundtrack: nothing while it is off), the disabled
 * "Manual edit" button with its "Soon" tag, and Close. The explanations are tooltips, never `title`
 * attributes. Must sit inside a `Dialog` (it holds the `DialogTitle`) and a `TooltipProvider`.
 */
export function ReviewDialogHeader({
  job,
  musicRev,
  formatSwitch,
  exportFormat,
  running = null,
}: {
  job: Pick<Job, 'id' | 'name' | 'client' | 'round'>;
  /**
   * Draft & chat: what the job's run is doing ("Drafting", "Round 1"), while there is no preview
   * to review. The badge says it with a blue dot, and Music, Export MP4 and Manual edit wait for
   * the preview. Default `null`: the header of a job in Review, as before.
   */
  running?: string | null;
  musicRev?: number;
  /** Generated videos: the format switch of a job with two formats, before the Music button. Default: none. */
  formatSwitch?: ReactNode;
  /**
   * Formats (C65): the format on show on a job with two, whose export the Export MP4 button makes
   * and saves, and whose size its label says. `id` is an extra format's id, `null` for the main
   * one. Default (a job with one format): the one export, with the words it always had.
   */
  exportFormat?: { id: string | null; label: string };
}) {
  const exported = useReviewExport(
    job.id,
    `${job.round}:${musicRev ?? ''}`,
    exportFormat?.id ?? null,
  );
  const words = exportWords(exportFormat);
  return (
    <div
      data-slot="review-header"
      // A container: in a narrow (portrait) dialog the disabled "Manual edit" gives up its words, so
      // the job's name and client keep the room (the Music button's label needs some of it).
      className="@container flex h-[60px] shrink-0 items-center gap-3 border-b pr-3 pl-5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <DialogTitle className="min-w-0 text-base leading-[1.4] font-semibold">
          <Bidi>{job.name}</Bidi>
        </DialogTitle>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <Bidi className="min-w-0 text-muted-foreground">{job.client}</Bidi>
        {running === null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge asChild variant="outline">
                <button
                  type="button"
                  className="shrink-0 cursor-help text-muted-foreground outline-none"
                >
                  <BadgeDot className="bg-status-ready" />
                  {REVIEW_DIALOG_TEXT.livePreview}
                </button>
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" sideOffset={6}>
              {REVIEW_DIALOG_TEXT.livePreviewTip}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Badge
            variant="outline"
            data-slot="review-running"
            className="shrink-0 text-muted-foreground"
          >
            <BadgeDot className="bg-blue-500" />
            {running}
          </Badge>
        )}
      </div>

      {running === null && (
        <>
          {formatSwitch}

          <MusicButton jobId={job.id} />

          <Tooltip>
            <TooltipTrigger asChild>
              {exported.state === 'ready' ? (
                <Button type="button" variant="outline" size="sm" asChild>
                  <a
                    href={reviewExportFileUrl(job.id, job.round, '', exportFormat?.id)}
                    download={reviewExportFileName(job.name, exportFormat?.id)}
                  >
                    <Download />
                    <span className="@max-[800px]:sr-only">{words.save}</span>
                  </a>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-slot="review-export"
                  disabled={exported.state === 'making'}
                  aria-busy={exported.state === 'making'}
                  onClick={exported.start}
                >
                  {exported.state === 'making' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Download />
                  )}
                  <span className="@max-[800px]:sr-only">
                    {exported.state === 'making'
                      ? REVIEW_DIALOG_TEXT.exportMaking
                      : exported.state === 'failed'
                        ? REVIEW_DIALOG_TEXT.exportFailed
                        : words.mp4}
                  </span>
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {exported.state === 'ready' ? words.readyTip : words.tip}
            </TooltipContent>
          </Tooltip>

          {/* A disabled button gets no pointer events, so its tooltip hangs on the span around it. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled button can't take focus, so the tooltip opens from this wrapper
                tabIndex={0}
                className="inline-flex shrink-0 cursor-default rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled
                  className="gap-2 pr-2 pl-3 has-[>svg]:pr-2 has-[>svg]:pl-3 @max-[800px]:px-2.5 @max-[800px]:has-[>svg]:px-2.5"
                >
                  <SquarePen />
                  <span className="@max-[800px]:sr-only">{REVIEW_DIALOG_TEXT.manualEdit}</span>
                  <span className="rounded-full bg-secondary px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground @max-[800px]:hidden">
                    {REVIEW_DIALOG_TEXT.soon}
                  </span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" sideOffset={6}>
              {REVIEW_DIALOG_TEXT.manualEditTip}
            </TooltipContent>
          </Tooltip>
        </>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={REVIEW_DIALOG_TEXT.close}
              className="text-muted-foreground"
            >
              <X />
            </Button>
          </DialogClose>
        </TooltipTrigger>
        <TooltipContent align="end" side="bottom" sideOffset={6}>
          {REVIEW_DIALOG_TEXT.closeTip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
