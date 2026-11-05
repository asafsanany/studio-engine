import type { FontRequest, Job } from '@studio/shared';
import { Button } from '@/components/ui/button';
import { bannerRequest, MISSING_FONT_TEXT, moreText, requestRunning } from './font-requests';

export interface MissingFontBannerProps {
  /** The open requests for a font the library does not have (`useFonts().data.requests`). */
  requests: readonly FontRequest[];
  /** "Import fonts": opens the page's import dialog. */
  onImport: () => void;
  /**
   * "Not a font" (C52): the word after the @ was never a font, so the request shown is dismissed
   * and the bar moves on to the next one. Left out, the bar has no such button.
   */
  onDismiss?: (request: FontRequest) => void;
  /** A dismissal is on its way: "Not a font" waits for the answer. */
  dismissing?: boolean;
  /** The engine can't be reached: importing waits with it. */
  offline?: boolean;
  /**
   * The job list (`useJobs().data`), to tell whether the run that asked is still going: then the
   * sentence says the edit "is using" the closest font, not "used". Left out (or without that job)
   * the sentence is the past tense, as it always was.
   */
  jobs?: readonly Pick<Job, 'id' | 'state'>[];
}

/**
 * The line above the Fonts page when a note named a font the library does not have (board FOPage
 * `start=missing`, FOStates 9): an amber dot, which job asked for which font, that the edit used (or,
 * while the job is still editing, is using) the closest font it has, and the button that opens
 * Import. With more than one open request it shows the newest and counts the rest ("(+2 more)").
 * Nothing at all while no request is open. "Not a font" (C52) next to Import dismisses the request
 * shown, for a word a note wrote after an @ that nobody meant as a font; the next one takes its place.
 */
export function MissingFontBanner({
  requests,
  onImport,
  onDismiss,
  dismissing = false,
  offline = false,
  jobs,
}: MissingFontBannerProps) {
  const shown = bannerRequest(requests);
  if (shown === null) return null;
  const { request, others } = shown;
  return (
    <div
      role="status"
      data-slot="missing-font-banner"
      className="flex flex-none items-center gap-2.5 border-b bg-card px-6 py-2 text-[13px] text-card-foreground"
    >
      <span aria-hidden="true" className="size-2 flex-none rounded-full bg-status-held" />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{request.jobName}</b>
        {MISSING_FONT_TEXT.asked}
        <b className="font-semibold">{request.name}</b>
        {requestRunning(request, jobs) ? MISSING_FONT_TEXT.restRunning : MISSING_FONT_TEXT.rest}
        {others > 0 && (
          <>
            {' '}
            <span data-slot="missing-font-more" className="text-muted-foreground">
              {moreText(others)}
            </span>
          </>
        )}
      </span>
      {onDismiss !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 flex-none px-2.5 text-[13px] text-muted-foreground"
          title={MISSING_FONT_TEXT.dismissHint}
          disabled={offline || dismissing}
          onClick={() => onDismiss(request)}
        >
          {MISSING_FONT_TEXT.dismiss}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 flex-none px-2.5 text-[13px]"
        disabled={offline}
        onClick={onImport}
      >
        {MISSING_FONT_TEXT.import}
      </Button>
    </div>
  );
}
